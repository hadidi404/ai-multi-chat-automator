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

  // Blocks holding Grok's replies, most specific first.
  // UPDATE THIS if the answers stop being read.
  response: [
    '.message-bubble',
    'div[class*="response-content"]',
    'div[class*="prose"]',
    '.markdown',
  ],
};

const URL = 'https://grok.com/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to Grok, waits for the answer, and reads it back.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<{ text: string, links: object[], ok: boolean }>}
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Grok', SELECTORS.input);

    // Counted before sending so the answer can be scoped to THIS question.
    const before = await snapshotResponses(page, SELECTORS.response);

    await typeIntoInput(page, inputSelector, question);

    // Submit
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[Grok] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'Grok', SELECTORS.stopButton);
    return await readNewResponse(page, 'Grok', SELECTORS.response, before);
  } catch (err) {
    logger.error('[Grok] Error:', err.message);
    return { text: '', links: [], ok: false, reason: err.message };
  }
}

// SELECTORS is exported so tools/inspect.js can probe them against the live
// page without duplicating the list.
module.exports = { open, run, url: URL, selectors: SELECTORS };
