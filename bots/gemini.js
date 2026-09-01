'use strict';

const {
  waitForInputReady,
  typeIntoInput,
  clickFirstMatching,
  waitForResponseToFinish,
  readNewResponse,
  snapshotResponses,
} = require('../utils/botHelpers');
const logger = require('../utils/logger');

const URL = 'https://gemini.google.com';

const INPUT_SELECTORS = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  'rich-textarea div[contenteditable="true"]',
  'rich-textarea div[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'div[contenteditable="true"][aria-label*="prompt" i]',
  'div[contenteditable="true"]',
];

const SEND_SELECTORS = [
  'button[aria-label*="Send message" i]',
  'button[aria-label="Send message"]',
  'button[aria-label*="Send" i]',
  'button[data-mat-icon-name="send"]',
  'button.send-button',
  'button[jsname*="send" i]',
];

const STOP_SELECTORS = [
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop" i]',
  'button[data-mat-icon-name="stop_circle"]',
];

// Blocks holding Gemini's replies, most specific first.
// UPDATE THIS if the answers stop being read.
const RESPONSE_SELECTORS = [
  'model-response',
  '.model-response-text',
  'message-content',
  '.markdown',
];

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

/**
 * Sends a single question to Gemini, waits for the answer, and reads it back.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<{ text: string, links: object[], ok: boolean }>}
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Gemini', INPUT_SELECTORS);
    const input = page.locator(inputSelector).first();

    // Counted before sending so the answer can be scoped to THIS question.
    const before = await snapshotResponses(page, RESPONSE_SELECTORS);

    // Clear existing content and type the question
    await input.click({ clickCount: 3 });
    await typeIntoInput(page, inputSelector, question);

    // Small pause to let Gemini enable the send button
    await page.waitForTimeout(500);

    // Try clicking send button; fall back to Enter key
    try {
      await clickFirstMatching(page, SEND_SELECTORS, 1_500);
    } catch {
      await input.press('Enter');
    }

    await waitForResponseToFinish(page, 'Gemini', STOP_SELECTORS);
    return await readNewResponse(page, 'Gemini', RESPONSE_SELECTORS, before);
  } catch (err) {
    logger.error('[Gemini] Error:', err.message);
    return { text: '', links: [], ok: false, reason: err.message };
  }
}

// SELECTORS is exported so tools/inspect.js can probe them against the live
// page without duplicating the list.
module.exports = {
  open,
  run,
  url: URL,
  selectors: {
    input: INPUT_SELECTORS,
    sendButton: SEND_SELECTORS,
    stopButton: STOP_SELECTORS,
    response: RESPONSE_SELECTORS,
  },
};
