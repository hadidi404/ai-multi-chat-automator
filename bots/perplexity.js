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

// ─────────────────────────────────────────────────────────────────────────────
// Perplexity bot (perplexity.ai)
//
// HOW LOGIN WORKS:
//   The browser launches with a persistent profile stored in ./user-data/.
//   Log in manually on the first run — the session is saved for future runs.
//
// SELECTOR NOTES:
//   Perplexity updates its UI often. Open perplexity.ai in the persistent
//   browser, inspect the input with DevTools, and update SELECTORS below
//   whenever the bot stops working.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
  // The main search / chat textarea on the home page.
  // UPDATE THIS if the selector stops matching.
  input: [
    'textarea[placeholder]',
    'textarea',
    'div[contenteditable="true"]',
  ],

  // Submit button next to the textarea.
  // UPDATE THIS if the selector stops matching.
  sendButton: [
    'button[aria-label="Submit"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
  ],

  // Perplexity shows a "Stop" button while generating.
  // We wait for it to appear, then disappear.
  // UPDATE THIS if the selector stops matching.
  stopButton: [
    'button[aria-label="Stop"]',
    'button[aria-label*="Stop" i]',
  ],

  // Blocks holding Perplexity's answers, most specific first.
  // UPDATE THIS if the answers stop being read.
  response: [
    '[id^="markdown-content"]',
    'div[class*="prose"]',
    '.prose',
  ],
};

const URL = 'https://www.perplexity.ai/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to Perplexity, waits for the answer, and reads it back.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<{ text: string, links: object[], ok: boolean }>}
 */
async function run(page, question) {
  try {
    const inputSelector = await waitForInputReady(page, 'Perplexity', SELECTORS.input);

    // Counted before sending so the answer can be scoped to THIS question.
    const before = await snapshotResponses(page, SELECTORS.response);

    await typeIntoInput(page, inputSelector, question);

    // Submit
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[Perplexity] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'Perplexity', SELECTORS.stopButton);
    return await readNewResponse(page, 'Perplexity', SELECTORS.response, before);
  } catch (err) {
    logger.error('[Perplexity] Error:', err.message);
    return { text: '', links: [], ok: false, reason: err.message };
  }
}

// SELECTORS is exported so tools/inspect.js can probe them against the live
// page without duplicating the list.
module.exports = { open, run, url: URL, selectors: SELECTORS };
