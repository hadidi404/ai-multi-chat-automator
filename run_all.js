'use strict';

// playwright-extra wraps playwright and allows plugins such as stealth.
// The stealth plugin patches browser properties (navigator.webdriver, chrome
// runtime, plugins, etc.) that Cloudflare / Turnstile use to detect bots.
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const path = require('path');

const { readQuestions } = require('./utils/readQuestions');
const { resolveBravePath } = require('./utils/resolveBravePath');
const logger = require('./utils/logger');

const BOTS = [
  { label: 'ChatGPT',    bot: require('./bots/chatgpt') },
  { label: 'Gemini',     bot: require('./bots/gemini') },
  { label: 'Perplexity', bot: require('./bots/perplexity') },
  { label: 'Grok',       bot: require('./bots/grok') },
  { label: 'Meta AI',    bot: require('./bots/meta') },
];

const USER_DATA_DIR = path.join(__dirname, 'user-data');

function bindSignalHandlers(context) {
  let isShuttingDown = false;

  const shutdown = async (signal) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    logger.info(`\nReceived ${signal}. Closing browser context...`);
    await context.close().catch(() => {});
    process.exit(0);
  };

  const onSigInt = () => {
    void shutdown('SIGINT');
  };

  const onSigTerm = () => {
    void shutdown('SIGTERM');
  };

  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  return () => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  };
}

async function waitForBrowserToClose(browser) {
  if (!browser || !browser.isConnected()) {
    return;
  }

  await new Promise((resolve) => {
    browser.once('disconnected', resolve);
  });
}

/**
 * Launches Brave with the persistent automation profile.
 * If the profile is already locked by another Brave process, print a clear
 * message so the user knows how to recover safely.
 *
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function launchBrowserContext() {
  try {
    const braveExecutablePath = resolveBravePath();

    if (braveExecutablePath) {
      logger.debug('Using Brave executable:', braveExecutablePath);
    } else {
      logger.warn('Brave executable not found. Falling back to Playwright Chromium.');
      logger.warn('Set BRAVE_PATH to force a custom Brave executable location.');
    }

    return await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      ...(braveExecutablePath ? { executablePath: braveExecutablePath } : {}),
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],  
    });
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.includes('ProcessSingleton')) {
      logger.error('\nThe Brave automation profile is already in use.');
      logger.error('Close any existing automation window that uses ./user-data and try again.');
      logger.error('If a previous run crashed, stop it before relaunching this script.\n');
    }

    throw err;
  }
}

async function main() {
  const questions = readQuestions();

  if (questions.length === 0) {
    logger.error('No questions found in questions.txt. Exiting.');
    process.exit(1);
  }

  logger.info(`Loaded ${questions.length} question(s).`);
  logger.info(`Starting persistent browser... (log level: ${logger.currentLevel})\n`);
  const context = await launchBrowserContext();
  const browser = context.browser();
  const unbindSignalHandlers = bindSignalHandlers(context);

  try {
    const existingPages = context.pages();
    const firstPage = existingPages[0] || await context.newPage();

    for (let index = 1; index < existingPages.length; index++) {
      await existingPages[index].close().catch(() => {});
    }

    for (let botIndex = 0; botIndex < BOTS.length; botIndex++) {
      const { label, bot } = BOTS[botIndex];
      logger.info(`\n[${label}] Starting ${questions.length} question(s)`);

      const page = botIndex === 0 ? firstPage : await context.newPage();

      if (typeof bot.open === 'function') {
        try {
          await bot.open(page);
        } catch (err) {
          logger.error(`[${label}] Failed to open target page: ${err.message}`);
          await page.close().catch(() => {});
          continue;
        }
      }

      for (let qi = 0; qi < questions.length; qi++) {
        const question = questions[qi];
        logger.info(`[${label}] Question ${qi + 1}/${questions.length}`);
        logger.debug(`[${label}] Prompt: ${question}`);

        try {
          await bot.run(page, question);
        } catch (err) {
          logger.error(`[${label}] Unexpected error: ${err.message}`);
        }
      }

      logger.info(`[${label}] Completed`);
    }

    logger.info('\nAll questions have been sent to all bots.');
    logger.info('The browser will stay open so the user can review the results.');
    logger.info('Close the browser window when you are done.');

    await waitForBrowserToClose(browser);
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  } finally {
    unbindSignalHandlers();
  }
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
