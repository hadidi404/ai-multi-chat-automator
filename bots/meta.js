'use strict';

const {
  clickFirstMatching,
  typeIntoInput,
  waitForInputReady,
  waitForResponseToFinish,
} = require('../utils/botHelpers');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Meta AI bot (meta.ai)
//
// HOW LOGIN WORKS:
//   The browser launches with a persistent profile stored in ./user-data/.
//   Log in with your Facebook / Meta account manually on the first run.
//   The session is saved in ./user-data/ and reused on all future runs.
//
// SELECTOR NOTES:
//   Meta AI's interface may change. Inspect elements in the persistent browser
//   and update SELECTORS below whenever the bot stops working.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
  // The chat input field.
  // UPDATE THIS if the selector stops matching.
  input: [
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea',
  ],

  // The send button.
  // UPDATE THIS if the selector stops matching.
  sendButton: [
    'div[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'div[role="button"][aria-label*="Send" i]',
  ],

  // Meta AI shows a "pause" or "stop" button while generating.
  // We wait for it to appear then disappear as a proxy for "done".
  // UPDATE THIS if the selector stops matching.
  stopButton: [
    'div[aria-label="Stop generating"]',
    'button[aria-label*="Stop" i]',
    'div[role="button"][aria-label*="Stop" i]',
  ],
};

const URL = 'https://www.meta.ai/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to Meta AI and waits for the response to finish.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Meta AI', SELECTORS.input);

    await typeIntoInput(page, inputSelector, question);

    // Submit
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[Meta AI] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'Meta AI', SELECTORS.stopButton);
  } catch (err) {
    logger.error('[Meta AI] Error:', err.message);
  }
}

module.exports = { open, run };
