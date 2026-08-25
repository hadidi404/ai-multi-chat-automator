'use strict';

// playwright-extra wraps playwright and allows plugins such as stealth.
// The stealth plugin patches browser properties (navigator.webdriver, chrome
// runtime, plugins, etc.) that Cloudflare / Turnstile use to detect bots.
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolveBrowserForProfile } = require('./resolveBrowser');
const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Shared browser session
//
// Launching Brave with the persistent profile, opening one tab per bot, and
// feeding questions through each bot in parallel.
// ─────────────────────────────────────────────────────────────────────────────

const USER_DATA_DIR = path.join(__dirname, '..', 'user-data');

const NEVER_STOP = () => false;

// Playwright's defaults include --use-mock-keychain and --password-store=basic,
// which stop Chromium reaching the real OS credential store.
//
// That quietly destroys the whole point of a shared profile on macOS: Chrome
// seals cookie values with a key kept in the keychain ("Chrome Safe Storage"),
// so a browser running on a MOCK keychain derives a different key and cannot
// read a single cookie the sign-in window wrote. Same browser, same profile,
// every site still signed out.
//
// --enable-automation is dropped for the usual reason: it is the flag sites
// look at to decide they are talking to a robot.
//
// On macOS both must go. Elsewhere only the mock keychain is worth dropping —
// on Linux, --password-store=basic is what avoids a desktop keyring prompt.
const IGNORED_DEFAULT_ARGS = process.platform === 'darwin'
  ? ['--enable-automation', '--use-mock-keychain', '--password-store=basic']
  : ['--enable-automation', '--use-mock-keychain'];

/**
 * Launches the browser with the persistent automation profile.
 * If the profile is already locked by another window of the same browser,
 * print a clear message so the user knows how to recover safely.
 *
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchBrowserContext() {
  try {
    const browser = resolveBrowserForProfile(USER_DATA_DIR);

    if (browser) {
      logger.info(`Using ${browser.name} — the browser this profile is signed in with.`);
      logger.debug(`Executable: ${browser.path}`);
    } else {
      logger.warn('Neither Chrome nor Brave was found. Falling back to Playwright Chromium.');
      logger.warn('Set BROWSER_PATH to point at the browser you want to use.');
    }

    return await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      ...(browser ? { executablePath: browser.path } : {}),
      chromiumSandbox: process.platform === 'win32',
      viewport: null,
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : '';

    // A Brave that is already open swallows the launch and hands back a dead
    // handle, so automation never gets a browser it can drive.
    const alreadyOpen = message.includes('Opening in existing browser session')
      || message.includes('ProcessSingleton')
      || message.includes('Target page, context or browser has been closed');

    if (alreadyOpen) {
      const name = (resolveBrowserForProfile(USER_DATA_DIR) || { name: 'The browser' }).name;
      logger.error(`\n${name} is already running, so the automation cannot start.`);

      if (process.platform === 'darwin') {
        logger.error(`Quit ${name} completely (Cmd+Q, or right-click its Dock icon and choose Quit), then try again.`);
      } else {
        logger.error(`Close every ${name} window, then try again.`);
      }

      logger.error('If a previous run crashed, make sure its window is gone before relaunching.\n');
    }

    throw err;
  }
}

/**
 * Opens the automation profile in an ORDINARY browser window — no Playwright,
 * no DevTools protocol, no automation flags.
 *
 * This is how signing in has to work. Google refuses a password on a browser it
 * can tell is automated ("this browser or app may not be secure"), and every
 * Playwright launch is detectable however much the flags are cleaned up. Same
 * profile directory, so a session saved here is the session the automation
 * finds later.
 *
 * The window is detached and outlives this process: closing it is the user's
 * job, and that is also what flushes the cookies to disk.
 *
 * @param {string[]} urls
 * @returns {{ child: import('child_process').ChildProcess, browserName: string }}
 */
function openProfileWindow(urls) {
  // Same resolver as the automation, so signing in and running questions can
  // never end up on different browsers — which would leave every saved cookie
  // sealed with a key the other one cannot read.
  const browser = resolveBrowserForProfile(USER_DATA_DIR);

  if (!browser) {
    throw new Error('Could not find Chrome or Brave. Install one of them, or set BROWSER_PATH to your browser.');
  }

  logger.info(`Signing in through ${browser.name}, matching the automation profile.`);

  const child = spawn(
    browser.path,
    [`--user-data-dir=${USER_DATA_DIR}`, '--start-maximized', ...urls],
    { detached: true, stdio: 'ignore' }
  );

  child.unref();
  logger.info(`Opened ${browser.name} with the automation profile for sign-in.`);

  return { child, browserName: browser.name };
}

/**
 * Whether a browser currently holds the automation profile.
 *
 * Chromium leaves a SingletonLock symlink pointing at "<hostname>-<pid>", so a
 * live pid means a window is still open on it. Returns null on Windows, which
 * uses a different lock this cannot read — there the caller falls back to
 * watching the process it spawned.
 *
 * Needed because a spawned browser does not always stay attached to the process
 * we started: it can hand off to an existing instance, or (on macOS) keep
 * running with every window closed.
 *
 * @returns {boolean | null}
 */
function isProfileInUse() {
  if (process.platform === 'win32') {
    return null;
  }

  let pid = 0;

  try {
    const target = fs.readlinkSync(path.join(USER_DATA_DIR, 'SingletonLock'));
    pid = Number(String(target).split('-').pop());
  } catch {
    return false;
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns exactly `count` usable tabs, reusing the blank tab Brave opens with
 * and closing any leftovers from a previous session.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {number} count
 * @returns {Promise<import('playwright').Page[]>}
 */
async function preparePages(context, count) {
  const existingPages = context.pages();
  const firstPage = existingPages[0] || await context.newPage();

  for (let index = 1; index < existingPages.length; index++) {
    await existingPages[index].close().catch(() => {});
  }

  const pages = [firstPage];
  for (let index = 1; index < count; index++) {
    pages.push(await context.newPage());
  }

  return pages;
}

/**
 * Raises the automation window so it is actually on screen.
 *
 * Launching the browser binary directly does not activate it the way opening
 * an app does, so on macOS — especially with an everyday Chrome already
 * running — the window can come up behind everything or on another desktop.
 * A run then looks like it is doing nothing at all, and the whole point is
 * being able to watch it.
 *
 * Best effort: failing to raise a window is never worth losing a run over.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function raiseWindow(page) {
  if (!page || page.isClosed()) {
    return;
  }

  await page.bringToFront().catch(() => {});
}

/**
 * Sends every question to one bot, in order, on its own tab.
 *
 * A failure on a single question is logged and skipped rather than aborting
 * the bot — one bad selector should not cost you the other questions.
 *
 * @param {{
 *   label: string,
 *   bot: { open?: Function, run: Function },
 *   page: import('playwright').Page,
 *   questions: string[],
 *   primer?: string,
 *   shouldStop?: () => boolean,
 *   onProgress?: (update: object) => void,
 *   onPage?: (entry: { label: string, page: import('playwright').Page }) => void,
 * }} options
 * @returns {Promise<{ label: string, success: boolean, reason?: string }>}
 */
async function runBotPipeline({
  label,
  bot,
  page,
  questions,
  primer = '',
  shouldStop = NEVER_STOP,
  onProgress,
  onResult,
  onPage,
}) {
  const report = (update) => {
    if (typeof onProgress === 'function') {
      onProgress({ label, ...update });
    }
  };

  const emitResult = (result) => {
    if (typeof onResult === 'function') {
      onResult(result);
    }
  };

  logger.info(`\n[${label}] Starting ${questions.length} question(s)`);
  report({ status: 'starting', total: questions.length, done: 0 });

  // Hand the tab to the caller so it can bring this bot's answers back on
  // screen after the run, without having to guess which tab is whose.
  if (typeof onPage === 'function') {
    onPage({ label, page });
  }

  if (typeof bot.open === 'function') {
    try {
      await bot.open(page);
    } catch (err) {
      logger.error(`[${label}] Failed to open target page: ${err.message}`);
      report({ status: 'failed', reason: 'open-failed' });
      await page.close().catch(() => {});
      return { label, success: false, reason: 'open-failed' };
    }
  }

  // One set-up message per conversation, before any question, telling the AI to
  // end every following answer with an "AI Output Summary" block. Sent here and
  // not with each question so it never lands in the tested prompt itself.
  //
  // Its reply produces no row, and a failure is not fatal: the answers are
  // still worth having, and analysis.js falls back to its own summariser.
  if (primer && !shouldStop()) {
    logger.info(`[${label}] Sending the summary instructions...`);
    report({ status: 'priming', total: questions.length, done: 0 });

    try {
      await bot.run(page, primer);
    } catch (err) {
      logger.warn(`[${label}] Summary instructions not accepted: ${err.message}`);
    }
  }

  for (let qi = 0; qi < questions.length; qi++) {
    if (shouldStop()) {
      logger.warn(`[${label}] Stopped before question ${qi + 1}.`);
      report({ status: 'stopped', total: questions.length, done: qi });
      return { label, success: false, reason: 'stopped' };
    }

    const question = questions[qi];
    logger.info(`[${label}] Question ${qi + 1}/${questions.length}`);
    logger.debug(`[${label}] Prompt: ${question}`);
    report({ status: 'running', total: questions.length, done: qi, question });

    const askedAt = new Date();
    let response = null;

    try {
      response = await bot.run(page, question);
    } catch (err) {
      logger.error(`[${label}] Unexpected error: ${err.message}`);
    }

    // The answer printed next to the question it was paired with — the one
    // part of the pipeline that can silently attach a row to the wrong reply.
    if (response) {
      const opening = String(response.text || '').replace(/\s+/g, ' ').slice(0, 70);
      logger.debug(`[${label}] Q${qi + 1} "${question.slice(0, 50)}"`);
      logger.debug(`[${label}] Q${qi + 1} answered: ${opening || '(empty)'}`);
    }

    // One result per question per bot — this becomes one spreadsheet row.
    emitResult({
      platform: label,
      platformHost: typeof bot.url === 'string' ? bot.url : '',
      question,
      questionIndex: qi,
      askedAt,
      response: response || null,
      readFailed: !response || response.ok === false,
    });

    report({ status: 'running', total: questions.length, done: qi + 1 });
  }

  logger.info(`[${label}] Completed`);
  report({ status: 'done', total: questions.length, done: questions.length });
  return { label, success: true };
}

/**
 * Full run: launch the browser, open a tab per bot, ask every question.
 *
 * The context is handed back through `onContext` as soon as it exists so the
 * caller can wire up Stop / shutdown handling while the run is still going.
 * The browser is deliberately left open on success so the user can read the
 * answers — closing it is the caller's decision.
 *
 * @param {{
 *   bots: { key: string, label: string, module: object }[],
 *   questions: string[],
 *   primer?: string,
 *   shouldStop?: () => boolean,
 *   onContext?: (context: import('playwright').BrowserContext) => void,
 *   onProgress?: (update: object) => void,
 * }} options
 * @returns {Promise<{
 *   context: import('playwright').BrowserContext,
 *   browser: import('playwright').Browser,
 *   results: PromiseSettledResult<object>[],
 * }>}
 */
async function startRun({
  bots,
  questions,
  primer = '',
  shouldStop = NEVER_STOP,
  onContext,
  onProgress,
  onResult,
  onPage,
}) {
  const context = await launchBrowserContext();

  if (typeof onContext === 'function') {
    onContext(context);
  }

  try {
    const pages = await preparePages(context, bots.length);

    // Put the window in front before any question goes out, so the run is
    // visible from the start rather than hiding behind the browser you were
    // already using.
    await raiseWindow(pages[0]);

    logger.info(`Running ${bots.length} AI bot(s) in parallel...`);

    const results = await Promise.allSettled(
      bots.map((entry, index) =>
        runBotPipeline({
          label: entry.label,
          bot: entry.module,
          page: pages[index],
          questions,
          primer,
          shouldStop,
          onProgress,
          onResult,
          onPage,
        })
      )
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(`[Parallel] Bot pipeline crashed: ${result.reason?.message || result.reason}`);
      }
    }

    return { context, browser: context.browser(), results };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

module.exports = {
  isProfileInUse,
  launchBrowserContext,
  openProfileWindow,
  raiseWindow,
  startRun,
};
