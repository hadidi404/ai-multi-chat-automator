'use strict';

// Local HTTP server: serves the UI, streams run progress over SSE, and
// turns each answered question into a spreadsheet row.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { listBots, resolveBots, allKeys, loginSites } = require('./bots');
const { dataPath } = require('./utils/paths');
const { setManualStepHandler } = require('./utils/pauseController');
const { isProfileInUse, openProfileWindow, raiseWindow, startRun } = require('./utils/session');
const { COLUMNS, buildRow, buildPendingRow } = require('./utils/analysis');
const { buildPrimer } = require('./utils/summaryPrompt');
const auth = require('./utils/auth');
const drive = require('./utils/drive');
const logger = require('./utils/logger');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const QUESTIONS_FILE = dataPath('questions.txt');
const SCREENSHOT_DIR = dataPath('screenshots');
const MAX_BODY_BYTES = 1_000_000;
const LOG_HISTORY_LIMIT = 500;
const APP_VERSION = require('./package.json').version;

const shouldOpenBrowser = !process.argv.includes('--no-open');
const MAX_IMAGE_BYTES = 12_000_000;

// Set once the server is listening. The OAuth redirect URI must match exactly,
// and the port can shift if 3000 was busy.
let activePort = DEFAULT_PORT;

function redirectUri() {
  return `http://localhost:${activePort}/oauth/callback`;
}

// Run state

const state = {
  status: 'idle', // idle | launching | running | login | finished | error
  message: '',
  bots: [], // { label, status, done, total }
  startedAt: null,
};

/** @type {import('playwright').BrowserContext | null} */
let activeContext = null;
let stopRequested = false;

/**
 * Spreadsheet rows for the current run — one per question per AI.
 *
 * @type {{ id: string, status: string, cells: object }[]}
 */
let resultRows = [];

/** @type {Map<string, { resolve: Function, reject: Function, message: string }>} */
const pendingManualSteps = new Map();

/** @type {Set<import('http').ServerResponse>} */
const eventClients = new Set();

/** @type {{ level: string, message: string, at: number }[]} */
const logHistory = [];

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const client of eventClients) {
    try {
      client.write(payload);
    } catch {
      eventClients.delete(client);
    }
  }
}

function pushLog(level, message) {
  const entry = { level, message, at: Date.now() };
  logHistory.push(entry);

  if (logHistory.length > LOG_HISTORY_LIMIT) {
    logHistory.shift();
  }

  broadcast({ type: 'log', ...entry });
}

function broadcastResults() {
  broadcast({ type: 'results', columns: COLUMNS, rows: resultRows });
}

/**
 * The detached sign-in window, while one is open. It holds the same profile
 * directory the automation uses, so a run cannot start until it is gone.
 */
let loginChild = null;

/**
 * The live tab per bot, while a run's browser is still open. Lets the grid send
 * the user straight to an answer instead of making them find the question again.
 */
const activePages = new Map();

function snapshot() {
  return {
    type: 'state',
    status: state.status,
    message: state.message,
    bots: state.bots,
    startedAt: state.startedAt,
    // Either kind of window counts: the automation's Playwright context, or the
    // detached window opened for signing in. The UI hangs its "Close browser" /
    // "I am done logging in" button off this.
    browserOpen: Boolean(activeContext || loginChild),
    waiting: [...pendingManualSteps.entries()].map(([label, entry]) => ({
      label,
      message: entry.message,
    })),
  };
}

function setState(patch) {
  Object.assign(state, patch);
  broadcast(snapshot());
}

// Manual steps: a bot pauses here when a site needs a human (login, CAPTCHA).

function handleManualStep({ botName, message }) {
  return new Promise((resolve, reject) => {
    if (stopRequested) {
      reject(new Error('Run stopped'));
      return;
    }

    pendingManualSteps.set(botName, { resolve, reject, message });
    broadcast(snapshot());
  });
}

function resolveManualStep(botName) {
  const entry = pendingManualSteps.get(botName);

  if (!entry) {
    return false;
  }

  pendingManualSteps.delete(botName);
  entry.resolve();
  broadcast(snapshot());
  return true;
}

function rejectAllManualSteps(reason) {
  for (const [label, entry] of pendingManualSteps) {
    pendingManualSteps.delete(label);
    entry.reject(new Error(reason));
  }

  broadcast(snapshot());
}

// Running

function isBusy() {
  return state.status === 'launching' || state.status === 'running';
}

/**
 * Takes ownership of a freshly launched context: remembers it, and resets the
 * app to idle when the window goes away (whether the user closed it by hand or
 * we closed it for them).
 */
function adoptContext(context) {
  activeContext = context;

  context.once('close', () => {
    if (activeContext !== context) {
      return;
    }

    activeContext = null;
    activePages.clear();
    setManualStepHandler(null);
    rejectAllManualSteps('Browser closed');
    setState({ status: 'idle', message: 'Browser closed.', bots: [] });
  });
}

/**
 * Opens every AI site in one ordinary browser window so the user can sign in.
 * The logins are written into ./user-data and reused by every later run.
 */
async function beginLogin() {
  const sites = loginSites();

  stopRequested = false;
  setState({
    status: 'launching',
    message: 'Opening the sign-in pages...',
    startedAt: Date.now(),
    bots: [],
  });

  logger.info(`\n[web] Login setup: opening ${sites.length} site(s)`);

  try {
    // Google first: signing in there is what unlocks "Continue with Google" on
    // the AI sites, and it is the one that refuses an automated browser.
    const { child, browserName } = openProfileWindow([
      'https://accounts.google.com/',
      ...sites.map((site) => site.url),
    ]);

    loginChild = child;

    child.once('exit', () => {
      if (loginChild === child) {
        finishLogin();
      }
    });

    // The spawned process is not a reliable signal on its own: the browser can
    // hand off to an instance we did not start, and on macOS closing every
    // window leaves it running. Watching the profile lock catches both.
    watchProfileLock();

    const quitHint = process.platform === 'darwin'
      ? `quit ${browserName} completely (Cmd+Q)`
      : `close every ${browserName} window`;

    logger.info(`[web] Sign in to each tab, then ${quitHint}.`);
    setState({
      status: 'login',
      message: `Sign in to each tab, then ${quitHint} — or click "I am done logging in".`,
    });
  } catch (err) {
    const friendly = friendlyLaunchError(err);
    logger.error(`[web] Login setup failed: ${friendly}`);
    setState({ status: 'error', message: friendly });
  }
}

/** Ends the sign-in phase once, whichever signal noticed the browser is gone. */
function finishLogin() {
  if (state.status !== 'login') {
    return;
  }

  loginChild = null;
  setState({ status: 'idle', message: 'Logins saved. You can run your questions now.', bots: [] });
}

/** Polls the profile lock until the sign-in browser lets go of it. */
function watchProfileLock() {
  let sawLock = false;

  const timer = setInterval(() => {
    if (state.status !== 'login') {
      clearInterval(timer);
      return;
    }

    const inUse = isProfileInUse();

    if (inUse === null) {
      clearInterval(timer);
      return;
    }

    if (inUse) {
      sawLock = true;
      return;
    }

    if (sawLock) {
      clearInterval(timer);
      finishLogin();
    }
  }, 2_000);

  // Never let this keep the server alive on its own.
  timer.unref();
}

/**
 * Turns a Playwright launch failure into something a non-technical user can
 * act on.
 */
function friendlyLaunchError(err) {
  const raw = String(err && err.message ? err.message : err);

  const braveAlreadyOpen = raw.includes('Opening in existing browser session')
    || raw.includes('ProcessSingleton')
    || raw.includes('Target page, context or browser has been closed');

  if (braveAlreadyOpen) {
    return process.platform === 'darwin'
      ? 'Brave is already running. Quit Brave completely (Cmd+Q, or right-click its Dock icon and choose Quit), then try again.'
      : 'Brave is already running. Close every Brave window, then try again.';
  }

  // Anything else: keep the first line so the status bar stays readable.
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine;
}

function parseQuestions(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input || '');

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Remembers the submitted questions in questions.txt so the box is pre-filled
 * with them next time the page loads.
 */
function saveQuestions(questions) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, `${questions.join('\n')}\n`, 'utf-8');
  } catch (err) {
    logger.warn(`[web] Could not update questions.txt: ${err.message}`);
  }
}

/**
 * A stopped, failed, or crashed run leaves rows that will never be answered.
 * Mark them so they don't sit as "waiting" forever — and so the user can see
 * at a glance which questions still need asking.
 */
function markUnfinishedRows() {
  let changed = false;

  for (const row of resultRows) {
    if (row.status === 'pending') {
      row.status = 'skipped';
      row.cells.Notes = 'Not asked — the run ended first.';
      changed = true;
    }
  }

  if (changed) {
    broadcastResults();
  }
}

async function beginRun({ questions, botKeys, clientName, clientSite }) {
  const bots = resolveBots(botKeys);

  if (bots.length === 0) {
    throw new Error('Pick at least one AI.');
  }

  if (questions.length === 0) {
    throw new Error('Type at least one question.');
  }

  stopRequested = false;
  saveQuestions(questions);

  // Sent to each chat once, ahead of the questions, so every answer comes back
  // with its own summary instead of us assembling one from its sentences.
  const primer = buildPrimer({ clientName });

  // Build the whole grid before the browser even opens. Rows are grouped by
  // question so a question's five platforms sit together in the sheet.
  const runId = `r${Date.now().toString(36)}`;
  resultRows = [];

  questions.forEach((question, questionIndex) => {
    for (const bot of bots) {
      resultRows.push({
        id: `${runId}:${bot.key}:${questionIndex}`,
        status: 'pending',
        cells: buildPendingRow({ question, platform: bot.label, clientName }),
      });
    }
  });

  broadcastResults();

  setState({
    status: 'launching',
    message: 'Starting Brave with your saved logins...',
    startedAt: Date.now(),
    bots: bots.map((bot) => ({ label: bot.label, status: 'pending', done: 0, total: questions.length })),
  });

  setManualStepHandler(handleManualStep);

  logger.info(`\n[web] Run requested: ${questions.length} question(s) x ${bots.length} bot(s)`);

  try {
    await startRun({
      bots,
      questions,
      primer,
      shouldStop: () => stopRequested,
      onContext: (context) => {
        adoptContext(context);
        setState({ status: 'running', message: 'Sending questions...' });
      },
      onPage: ({ label, page }) => {
        activePages.set(label, page);
      },
      onProgress: (update) => {
        const entry = state.bots.find((bot) => bot.label === update.label);

        if (entry) {
          Object.assign(entry, {
            status: update.status,
            done: update.done ?? entry.done,
            total: update.total ?? entry.total,
          });
        }

        broadcast(snapshot());
      },
      onResult: (result) => {
        const bot = bots.find((entry) => entry.label === result.platform);
        const id = bot ? `${runId}:${bot.key}:${result.questionIndex}` : null;
        const row = resultRows.find((entry) => entry.id === id);

        const cells = buildRow({
          question: result.question,
          platform: result.platform,
          platformHost: result.platformHost,
          clientName,
          clientSite,
          response: result.response,
          readFailed: result.readFailed,
          askedAt: result.askedAt,
        });

        // An answer that arrived without the summary block means the set-up
        // message never took — a slow load, a rate limit, a skipped first
        // message. The cell stays empty, so say why while the run is still on
        // screen rather than leaving it to be noticed in the sheet later.
        if (!result.readFailed && !cells['AI Output Summary']) {
          logger.warn(`[web] ${result.platform} answered question ${result.questionIndex + 1} without an AI Output Summary — that cell is empty.`);
        }

        if (row) {
          row.cells = cells;
          row.status = result.readFailed ? 'unread' : 'done';
        } else {
          // Should not happen, but never drop a result on the floor.
          resultRows.push({ id: id || `orphan:${resultRows.length}`, status: 'done', cells });
        }

        broadcastResults();
      },
    });

    markUnfinishedRows();

    // If the user closed the window mid-run, the close handler already reset
    // us to idle — don't overwrite that with a "finished" message.
    if (!activeContext) {
      return;
    }

    setState({
      status: 'finished',
      message: stopRequested
        ? 'Stopped. The browser is still open.'
        : 'All questions sent. Read the answers in the Brave window.',
    });
  } catch (err) {
    activeContext = null;
    setManualStepHandler(null);
    rejectAllManualSteps('Run failed');

    // The launch itself failed, so no row will ever be answered.
    markUnfinishedRows();

    const friendly = friendlyLaunchError(err);
    logger.error(`[web] Run failed: ${friendly}`);
    setState({ status: 'error', message: friendly });
  }
}

/**
 * Finds one question in a conversation.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<import('playwright').Locator | null>}
 */
/**
 * Builds a pattern for the first `wordCount` words of a question.
 *
 * A plain substring is too brittle to find text a site has re-typeset. Sites
 * turn quotes curly, collapse or insert whitespace, and hyphenate across
 * lines, so the pattern allows any whitespace between words and accepts either
 * form of each quote character.
 *
 * @param {string[]} words
 * @param {number} wordCount
 * @returns {RegExp}
 */
function questionPattern(words, wordCount) {
  const escaped = words.slice(0, wordCount).map((word) => word
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['‘’]/g, "['‘’]")
    .replace(/["“”]/g, '["“”]'));

  return new RegExp(escaped.join('\\s+'), 'i');
}

/**
 * Finds a question in a conversation.
 *
 * Tries a long match first and falls back to shorter ones. A long pattern is
 * unambiguous but easily broken by the site's own formatting; a short one
 * always matches something but could match the wrong message, so it is only
 * used once the longer attempts have failed.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<import('playwright').Locator | null>}
 */
/**
 * Scrolls the conversation, returning false once it cannot go further.
 *
 * Picks the tallest scrollable element on the page rather than the window:
 * these chats scroll inside a container, so scrolling the document itself
 * moves nothing.
 *
 * @param {import('playwright').Page} page
 * @param {number} direction -1 to scroll up, 1 to scroll down
 * @returns {Promise<boolean>}
 */
async function scrollConversation(page, direction) {
  try {
    return await page.evaluate((dir) => {
      const scrollable = [...document.querySelectorAll('*')]
        .filter((el) => el.scrollHeight > el.clientHeight + 200)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;

      if (!scrollable) {
        return false;
      }

      const before = scrollable.scrollTop;
      scrollable.scrollTop += dir * scrollable.clientHeight * 0.8;
      return scrollable.scrollTop !== before;
    }, direction);
  } catch {
    return false;
  }
}

/** Looks for the question in whatever is currently rendered. */
async function findQuestionOnScreen(page, words) {
  for (const wordCount of [14, 9, 6, 4]) {
    if (wordCount > words.length && wordCount !== 4) {
      continue;
    }

    try {
      // `.last()` because re-running a question leaves it in the thread more
      // than once, and the newest is the one just asked.
      const found = page.getByText(questionPattern(words, wordCount)).last();

      if (await found.count() > 0) {
        return found;
      }
    } catch {
      // An invalid pattern for this question; the next size may still work.
    }
  }

  return null;
}

/**
 * Finds a question in a conversation, scrolling back through it if needed.
 *
 * These sites unmount messages that scroll out of view, so a question far
 * enough up the thread is not in the page at all until the container is
 * scrolled to it — searching alone would report it missing.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<import('playwright').Locator | null>}
 */
async function locateQuestion(page, question) {
  const words = String(question || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  if (words.length === 0) {
    return null;
  }

  const onScreen = await findQuestionOnScreen(page, words);

  if (onScreen) {
    return onScreen;
  }

  // Work upwards: the question was asked before the answer being looked at, so
  // it is above whatever is on screen now.
  for (let step = 0; step < 25; step++) {
    if (!await scrollConversation(page, -1)) {
      break;
    }

    // Virtualised lists mount rows a frame after the scroll.
    await page.waitForTimeout(150);

    const found = await findQuestionOnScreen(page, words);

    if (found) {
      return found;
    }
  }

  return null;
}

/** Marks a question in the page so it is obvious the right one is on screen. */
function highlightInPage(el) {
  // Climb while the parent is still essentially just this message. A parent
  // holding much more text is the thread, not the bubble.
  let box = el;

  for (let step = 0; step < 4; step++) {
    const parent = box.parentElement;

    if (!parent) {
      break;
    }

    const mine = (box.textContent || '').trim().length;
    const theirs = (parent.textContent || '').trim().length;

    // A wrapper adds little more than whitespace or a label. Anything that
    // brings substantially more text is the thread, not this message.
    if (theirs > mine * 1.25 + 24) {
      break;
    }

    box = parent;
  }

  const before = {
    outline: box.style.outline,
    outlineOffset: box.style.outlineOffset,
    borderRadius: box.style.borderRadius,
    background: box.style.backgroundColor,
    transition: box.style.transition,
  };

  box.style.transition = 'outline-color 0.4s ease, background-color 0.4s ease';
  box.style.outline = '3px solid #4f46e5';
  box.style.outlineOffset = '4px';
  box.style.borderRadius = '8px';
  box.style.backgroundColor = 'rgba(79, 70, 229, 0.12)';

  box.scrollIntoView({ block: 'center', behavior: 'smooth' });

  // Fade out, then put every touched property back exactly as it was.
  setTimeout(() => {
    box.style.outline = '3px solid transparent';
    box.style.backgroundColor = 'transparent';
  }, 3600);

  setTimeout(() => {
    box.style.outline = before.outline;
    box.style.outlineOffset = before.outlineOffset;
    box.style.borderRadius = before.borderRadius;
    box.style.backgroundColor = before.background;
    box.style.transition = before.transition;
  }, 4200);
}

/**
 * Set by the desktop shell to hand the foreground over before the browser is
 * raised. Nothing registers it when the app runs in a normal browser tab,
 * because there is no window of ours in the way.
 *
 * @type {(() => Promise<void> | void) | null}
 */
let yieldForeground = null;

function setYieldForeground(fn) {
  yieldForeground = typeof fn === 'function' ? fn : null;
}

/**
 * Brings the tab holding one exchange to the front and scrolls it into view.
 *
 * @param {string} rowId
 */
async function revealAnswer(rowId) {
  const row = resultRows.find((entry) => entry.id === rowId);

  if (!row) {
    throw new Error('That row is not part of the current run.');
  }

  const label = row.cells['AI Platform'];
  const page = activePages.get(label);

  if (!page || page.isClosed()) {
    throw new Error(`The ${label} tab is closed. Reopening it means running the question again.`);
  }

  // Let the desktop shell step out of the way first. Windows only allows the
  // process that currently holds the foreground to give it up, so without this
  // the browser is raised by a background process and Windows refuses — the
  // tab activates and the answer highlights, offscreen, while the taskbar
  // button flashes.
  if (typeof yieldForeground === 'function') {
    try {
      await yieldForeground();
    } catch {
      // Not fatal — worst case the window stays where it is.
    }
  }

  await raiseWindow(page);

  const target = await locateQuestion(page, row.cells['Prompt / Query Tested']);

  if (!target) {
    return {
      platform: label,
      scrolled: false,
      message: `Brought ${label} to the front, but could not find that question on the page.`,
    };
  }

  try {
    await target.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await target.evaluate(highlightInPage);
  } catch {
    // The page moved on; the tab is still in front, which is the main thing.
    return { platform: label, scrolled: false };
  }

  return { platform: label, scrolled: true };
}

/** Brings the run's browser window forward, whichever tab is handy. */
async function showBrowser() {
  for (const page of activePages.values()) {
    if (page && !page.isClosed()) {
      // Same foreground rule as the jump: stand down before raising the browser.
      if (typeof yieldForeground === 'function') {
        await yieldForeground().catch(() => {});
      }

      await raiseWindow(page);
      return { shown: true };
    }
  }

  throw new Error('No browser window is open right now.');
}

async function stopRun() {
  stopRequested = true;
  rejectAllManualSteps('Run stopped');
  setState({ message: 'Stopping...' });
}

async function closeBrowser() {
  const wasLogin = state.status === 'login';

  stopRequested = true;
  rejectAllManualSteps('Browser closing');

  // SIGTERM is how Chrome and Brave are asked to quit cleanly; anything harsher
  // risks losing the very cookies the sign-in was for.
  if (loginChild) {
    const child = loginChild;
    loginChild = null;

    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }

  if (activeContext) {
    await activeContext.close().catch(() => {});
    activeContext = null;
  }

  setManualStepHandler(null);
  setState({
    status: 'idle',
    message: wasLogin ? 'Logins saved. You can run your questions now.' : 'Browser closed.',
    bots: [],
  });
}

// HTTP plumbing

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');

      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function readRawBody(req, limit = MAX_IMAGE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error('That image is too large (max 12 MB).'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) {
      sendJson(res, 500, { error: 'public/index.html is missing.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  eventClients.add(res);

  // Replay recent output so a page reload does not lose the run's history.
  for (const entry of logHistory) {
    res.write(`data: ${JSON.stringify({ type: 'log', ...entry })}\n\n`);
  }

  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'results', columns: COLUMNS, rows: resultRows })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'drive', ...drive.status() })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'auth', ...auth.status() })}\n\n`);

  // Proxies and browsers drop idle streams; a comment every 20 s keeps it warm.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    eventClients.delete(res);
  });
}

async function handleApi(req, res, pathname) {
  // Above the sign-in gate: knowing which build someone is running is the
  // first thing worth asking when something misbehaves, signed in or not.
  if (req.method === 'GET' && pathname === '/api/version') {
    sendJson(res, 200, { version: APP_VERSION });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    sendJson(res, 200, auth.status());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/start') {
    try {
      openInBrowser(auth.buildSignInUrl(redirectUri()));
      sendJson(res, 200, { opened: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }

    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/signout') {
    auth.signOut();
    broadcast({ type: 'auth', ...auth.status() });
    sendJson(res, 200, auth.status());
    return;
  }

  // Everything past this point requires a signed-in account, so a new
  // endpoint is closed by default rather than open by omission.
  if (!auth.status().signedIn) {
    sendJson(res, 401, { error: 'Sign in with your work Google account first.' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bots') {
    sendJson(res, 200, { bots: listBots(), defaults: allKeys() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, snapshot());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/results') {
    sendJson(res, 200, { columns: COLUMNS, rows: resultRows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/questions') {
    let text = '';

    try {
      text = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
    } catch {
      text = '';
    }

    sendJson(res, 200, { text });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    if (isBusy()) {
      sendJson(res, 409, { error: 'A run is already in progress.' });
      return;
    }

    if (activeContext || loginChild) {
      sendJson(res, 409, {
        error: 'The browser window is still open. Close it before starting a new run.',
      });
      return;
    }

    const body = await readBody(req);
    const questions = parseQuestions(body.questions);
    const botKeys = Array.isArray(body.bots) ? body.bots : allKeys();

    if (questions.length === 0) {
      sendJson(res, 400, { error: 'Type at least one question.' });
      return;
    }

    if (botKeys.length === 0) {
      sendJson(res, 400, { error: 'Pick at least one AI.' });
      return;
    }

    // Reply immediately — the run itself takes minutes and reports over SSE.
    sendJson(res, 202, { started: true, questions: questions.length, bots: botKeys.length });
    void beginRun({
      questions,
      botKeys,
      clientName: String(body.clientName || '').trim(),
      clientSite: String(body.clientSite || '').trim(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/drive/status') {
    sendJson(res, 200, drive.status());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/drive/folder') {
    const body = await readBody(req);
    const folderId = drive.saveFolder(body.folder);
    sendJson(res, 200, { ...drive.status(), folderId });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/drive/connect') {
    const url = drive.buildAuthUrl(redirectUri());
    openInBrowser(url);
    sendJson(res, 200, { url });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/drive/disconnect') {
    drive.disconnect();
    sendJson(res, 200, drive.status());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/drive/upload') {
    const url = new URL(req.url, `http://${HOST}`);
    const name = url.searchParams.get('name') || `screenshot-${Date.now()}.png`;
    const mimeType = req.headers['content-type'] || 'image/png';

    const buffer = await readRawBody(req);

    if (buffer.length === 0) {
      sendJson(res, 400, { error: 'No image data received.' });
      return;
    }

    // Keep a local copy: if Drive ever rejects the upload the screenshot is
    // still on disk rather than lost with the clipboard.
    try {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SCREENSHOT_DIR, name), buffer);
    } catch (err) {
      logger.warn(`[web] Could not save a local copy of ${name}: ${err.message}`);
    }

    const uploaded = await drive.uploadImage({ buffer, mimeType, name });
    logger.info(`[web] Screenshot uploaded to Drive: ${name}`);
    sendJson(res, 200, uploaded);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    if (isBusy()) {
      sendJson(res, 409, { error: 'A run is already in progress.' });
      return;
    }

    if (activeContext) {
      sendJson(res, 409, {
        error: 'A browser window is already open. Close it before starting login setup.',
      });
      return;
    }

    // Reply immediately — opening five sign-in tabs takes a while.
    sendJson(res, 202, { started: true });
    void beginLogin();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/continue') {
    const body = await readBody(req);
    const label = String(body.bot || '');

    sendJson(res, 200, { resolved: resolveManualStep(label) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/stop') {
    await stopRun();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/show-browser') {
    try {
      sendJson(res, 200, await showBrowser());
    } catch (err) {
      sendJson(res, 409, { error: err.message });
    }

    return;
  }

  if (req.method === 'POST' && pathname === '/api/reveal') {
    const body = await readBody(req);

    try {
      const result = await revealAnswer(String(body.id || ''));
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 409, { error: err.message });
    }

    return;
  }

  if (req.method === 'POST' && pathname === '/api/close-browser') {
    await closeBrowser();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);

  if (pathname === '/api/events') {
    serveEvents(req, res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      sendJson(res, 400, { error: String(err.message || err) });
    });
    return;
  }

  // Google sends the user's browser back here after they approve access.
  if (req.method === 'GET' && pathname === '/oauth/callback') {
    const { searchParams } = new URL(req.url, `http://${HOST}`);
    const finish = (heading, detail) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${heading}</title>`
        + '<body style="font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;padding:48px;max-width:34rem;margin:0 auto">'
        + `<h1 style="font-size:20px">${heading}</h1><p style="color:#555">${detail}</p>`
        + '<p style="color:#555">You can close this tab and go back to AI Multi-Chat.</p>');
    };

    // Sign-in and Drive share a client, so the redirect URI is identical and
    // `state` is what tells the two flows apart.
    const isSignIn = searchParams.get('state') === 'signin';
    const failureTitle = isSignIn ? 'Not signed in' : 'Google Drive was not connected';
    const error = searchParams.get('error');

    if (error) {
      finish(failureTitle, `Google reported: ${error}`);
      return;
    }

    if (isSignIn) {
      try {
        const who = await auth.completeSignIn(searchParams.get('code'), redirectUri());
        logger.info(`[web] Signed in as ${who.email}.`);
        broadcast({ type: 'auth', ...auth.status() });
        finish(`Signed in as ${who.email}`, `This copy is for @${who.domain} accounts.`);
      } catch (err) {
        logger.error(`[web] Sign-in refused: ${err.message}`);
        broadcast({ type: 'auth-error', message: String(err.message || err) });
        finish(failureTitle, String(err.message || err));
      }

      return;
    }

    try {
      await drive.exchangeCode(searchParams.get('code'), redirectUri());
      logger.info('[web] Google Drive connected.');
      broadcast({ type: 'drive', ...drive.status() });
      finish('Google Drive connected', 'Screenshots you paste will now upload to your chosen folder.');
    } catch (err) {
      logger.error(`[web] Drive connection failed: ${err.message}`);
      finish(failureTitle, String(err.message || err));
    }

    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

// Startup

function openInBrowser(url) {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;

  exec(command, () => {
    // Opening the browser is a convenience; the URL is printed either way.
  });
}

/**
 * Starts listening, stepping to the next port when one is taken.
 *
 * @param {number} port
 * @param {number} [attemptsLeft]
 * @param {(url: string) => void} [onReady]
 */
function listen(port, attemptsLeft = 10, onReady) {
  const onError = (err) => {
    server.removeListener('listening', onListening);

    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1, onReady);
      return;
    }

    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  };

  const onListening = () => {
    server.removeListener('error', onError);

    activePort = port;
    const url = `http://localhost:${port}`;

    console.log('');
    console.log('  AI Multi-Chat — web UI');
    console.log('  ──────────────────────');
    console.log(`  Open:  ${url}`);
    console.log('  Stop:  press Ctrl+C in this window');
    console.log('');

    // Log lines are mirrored to the page only once the server is actually up.
    logger.addSink(pushLog);

    // Confirm the signed-in account still exists on every launch, so removing
    // someone from the Workspace locks them out the next time they open this.
    if (auth.status().signedIn) {
      auth.revalidate().then((result) => {
        if (!result.valid) {
          logger.warn('[web] That Google account is no longer valid. Sign in again.');
          broadcast({ type: 'auth', ...auth.status() });
        }
      });
    }

    if (typeof onReady === 'function') {
      onReady(url);
      return;
    }

    if (shouldOpenBrowser) {
      openInBrowser(url);
    }
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

// Ctrl+C, a closed console window, and `kill` all have to take the browser
// down with us. An orphaned Brave keeps holding the profile, and the next run
// then fails to launch for reasons the user cannot see.
let isShuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`\nShutting down (${signal})...`);
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}

// Loaded by the desktop shell, which starts it itself and wants the URL back.
// Run directly with `npm run web`, it starts on its own exactly as before.
if (require.main === module) {
  listen(DEFAULT_PORT);
}

module.exports = { listen, closeBrowser, setYieldForeground, DEFAULT_PORT };
