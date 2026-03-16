'use strict';

const {
  clickFirstMatching,
  typeIntoInput,
  waitForInputReady,
  waitForResponseToFinish,
} = require('../utils/botHelpers');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Grok bot (grok.com / x.com/i/grok)
//
// HOW LOGIN WORKS:
//   The browser launches with a persistent profile stored in ./user-data/.
//   Log in to X (Twitter) manually on the first run — the session is saved.
//   Grok lives inside X, so you need an X account.
//
// SELECTOR NOTES:
//   X/Grok's UI can change with deployments. Update SELECTORS below
//   if the bot stops working — inspect elements in the persistent browser.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
  // The input area where you type messages to Grok.
  // UPDATE THIS if the selector stops matching.
  input: [
    'textarea[placeholder]',
    'textarea',
    'div[contenteditable="true"]',
  ],

  // The send button.
  // UPDATE THIS if the selector stops matching.
  sendButton: [
    'button[aria-label="Send"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
  ],

  // Grok shows a "Stop generating" button while the response streams.
  // UPDATE THIS if the selector stops matching.
  stopButton: [
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop" i]',
  ],
};

const URL = 'https://grok.com/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to Grok and waits for the response to finish.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Grok', SELECTORS.input);

    await typeIntoInput(page, inputSelector, question);

    // Submit
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[Grok] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'Grok', SELECTORS.stopButton);
  } catch (err) {
    logger.error('[Grok] Error:', err.message);
  }
}

module.exports = { open, run };
