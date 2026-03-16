'use strict';
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const path = require('path');
const { resolveBravePath } = require('./utils/resolveBravePath');
const { waitForEnter } = require('./utils/waitForEnter');
const logger = require('./utils/logger');

const USER_DATA_DIR = path.join(__dirname, 'user-data');

const SITES = [
  { label: 'ChatGPT',    url: 'https://chatgpt.com' },
  { label: 'Gemini',     url: 'https://gemini.google.com' },
  { label: 'Perplexity', url: 'https://www.perplexity.ai' },
  { label: 'Grok',       url: 'https://grok.com' },
  { label: 'Meta AI',    url: 'https://www.meta.ai' },
];

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
      chromiumSandbox: process.platform === 'win32',
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
  logger.info('Launching Brave browser with persistent profile at:', USER_DATA_DIR);
  const context = await launchBrowserContext();

  for (const site of SITES) {
    logger.info(`Opening ${site.label}...`);
    try {
      const page = await context.newPage();
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      logger.error(`Failed to open ${site.label}: ${err.message}`);
    }
  }

  logger.info('\nPlease log in to all AI websites in the browser.');
  logger.info('Press ENTER in this terminal when you are finished.');
  await waitForEnter('');

  logger.info('Login setup complete.');
  await context.close();
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
