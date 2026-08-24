'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Local web UI
//
// Serves a page at http://localhost:3000: sign in to the AI sites, type your
// questions, then send them to one AI or all of them. Answers are read back
// and turned into rows ready to paste into the tracking sheet.
//
// WHY LOCALHOST ONLY:
//   A run drives a real browser that is logged into your personal ChatGPT /
//   Gemini / Grok / Perplexity / Meta accounts. Anyone who can reach this
//   server can send prompts from those accounts, so it binds to 127.0.0.1 and
//   is never exposed to the network.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { listBots, resolveBots, allKeys, loginSites } = require('./bots');
const { setManualStepHandler } = require('./utils/pauseController');
const { openProfileWindow, startRun } = require('./utils/session');
const { COLUMNS, buildRow, buildPendingRow } = require('./utils/analysis');
const { buildPrimer } = require('./utils/summaryPrompt');
const drive = require('./utils/drive');
const logger = require('./utils/logger');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const QUESTIONS_FILE = path.join(__dirname, 'questions.txt');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const MAX_BODY_BYTES = 1_000_000;
const LOG_HISTORY_LIMIT = 500;

const shouldOpenBrowser = !process.argv.includes('--no-open');
const MAX_IMAGE_BYTES = 12_000_000;

// Set once the server is listening. The OAuth redirect URI must match exactly,
// and the port can shift if 3000 was busy.
let activePort = DEFAULT_PORT;

function redirectUri() {
  return `http://localhost:${activePort}/oauth/callback`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run state
// ─────────────────────────────────────────────────────────────────────────────

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
 * The whole grid is created up front when a run starts, so the rows are there
 * to look at immediately and the answer columns fill in as replies arrive.
 * Each row carries a stable `id` so the page can match an update to the row it
 * belongs to, and keep any edits the user made to the others.
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

function snapshot() {
  return {
    type: 'state',
    status: state.status,
    message: state.message,
    bots: state.bots,
    startedAt: state.startedAt,
    browserOpen: Boolean(activeContext),
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

// ─────────────────────────────────────────────────────────────────────────────
// Manual steps (login / CAPTCHA / consent)
//
// A bot that cannot find its input box calls this and blocks. The UI shows a
// Continue button for that bot; clicking it resolves the promise. Stopping the
// run rejects instead, so the pipeline unwinds rather than hanging.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────

function isBusy() {
  return state.status === 'launching' || state.status === 'running';
}

/**
 * The detached sign-in window, while one is open. It holds the same profile
 * directory the automation uses, so a run cannot start until it is gone.
 */
let loginChild = null;

/**
 * Takes ownership of a freshly launched context: remembers it, and resets the
 * app to idle when the window goes away (whether the user closed it by hand or
 * we closed it for them).
 *
 * Listening on the context rather than the browser covers persistent profiles,
 * where context.browser() is not guaranteed to be present.
 */
function adoptContext(context) {
  activeContext = context;

  context.once('close', () => {
    if (activeContext !== context) {
      return;
    }

    activeContext = null;
    setManualStepHandler(null);
    rejectAllManualSteps('Browser closed');
    setState({ status: 'idle', message: 'Browser closed.', bots: [] });
  });
}

/**
 * Opens every AI site in one ordinary browser window so the user can sign in.
 * The logins are written into ./user-data and reused by every later run.
 *
 * Deliberately NOT a Playwright window. Google rejects a password typed into a
 * browser it detects as automated, which is every Playwright launch no matter
 * how the flags are cleaned up, so signing in has to happen in a plain window
 * pointed at the same profile.
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
      if (loginChild !== child) {
        return;
      }

      loginChild = null;
      setState({ status: 'idle', message: 'Logins saved. You can run your questions now.', bots: [] });
    });

    logger.info(`[web] Sign in to each tab in the ${browserName} window, then close it.`);
    setState({
      status: 'login',
      message: `Sign in to each tab in the ${browserName} window, then close that window.`,
    });
  } catch (err) {
    const friendly = friendlyLaunchError(err);
    logger.error(`[web] Login setup failed: ${friendly}`);
    setState({ status: 'error', message: friendly });
  }
}

/**
 * Turns a Playwright launch failure into something a non-technical user can
 * act on.
 *
 * The common one by far: Brave is already open. A running Brave takes over the
 * launch ("Opening in existing browser session") and hands back a dead handle,
 * so automation never gets a browser it can drive. Playwright reports that as
 * a multi-kilobyte dump of every command-line flag, which is useless in a
 * status bar — so match the signatures and say the one thing that fixes it.
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP plumbing
// ─────────────────────────────────────────────────────────────────────────────

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

  if (req.method === 'POST' && pathname === '/api/drive/client') {
    const body = await readBody(req);
    drive.saveClient({ clientId: body.clientId, clientSecret: body.clientSecret });
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

    const error = searchParams.get('error');

    if (error) {
      finish('Google Drive was not connected', `Google reported: ${error}`);
      return;
    }

    try {
      await drive.exchangeCode(searchParams.get('code'), redirectUri());
      logger.info('[web] Google Drive connected.');
      broadcast({ type: 'drive', ...drive.status() });
      finish('Google Drive connected', 'Screenshots you paste will now upload to your chosen folder.');
    } catch (err) {
      logger.error(`[web] Drive connection failed: ${err.message}`);
      finish('Google Drive was not connected', String(err.message || err));
    }

    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveIndex(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

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

function listen(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
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

    if (shouldOpenBrowser) {
      openInBrowser(url);
    }
  });
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

listen(DEFAULT_PORT);
