'use strict';

const {
  clickFirstMatching,
  readNewResponse,
  snapshotResponses,
  typeIntoInput,
  waitForInputReady,
  waitForResponseToFinish,
} = require('../utils/botHelpers');
const logger = require('../utils/logger');

// Selectors change often; update SELECTORS below when the bot stops working.

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

  // Blocks holding Meta AI's replies, most specific first.
  // Meta's markup is heavily obfuscated, so this is the least reliable reader
  // of the five. UPDATE THIS if the answers stop being read.
  response: [
    'div[data-testid*="message"]',
    'div[role="article"]',
    'div[dir="auto"]',
  ],
};

const URL = 'https://www.meta.ai/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to Meta AI, waits for the answer, and reads it back.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<{ text: string, links: object[], ok: boolean }>}
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Meta AI', SELECTORS.input);

    // Counted before sending so the answer can be scoped to THIS question.
    const before = await snapshotResponses(page, SELECTORS.response);

    await typeIntoInput(page, inputSelector, question);

    // Submit
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[Meta AI] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'Meta AI', SELECTORS.stopButton);
    return await readNewResponse(page, 'Meta AI', SELECTORS.response, before);
  } catch (err) {
    logger.error('[Meta AI] Error:', err.message);
    return { text: '', links: [], ok: false, reason: err.message };
  }
}

// SELECTORS is exported so tools/inspect.js can probe them against the live
// page without duplicating the list.
module.exports = { open, run, url: URL, selectors: SELECTORS };
