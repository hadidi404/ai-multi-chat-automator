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
// ChatGPT bot
//
// HOW LOGIN WORKS:
//   The browser launches with a persistent profile stored in ./user-data/.
//   The first time you run this, ChatGPT will ask you to log in.
//   Log in manually, then the session cookie will be saved in ./user-data/ and
//   reused on every subsequent run — no need to log in again.
//
// SELECTOR NOTES:
//   OpenAI's UI changes frequently. If the bot stops working, open ChatGPT in
//   the persistent browser and inspect the chat input with DevTools to find
//   the current selector, then update SELECTORS below.
// ─────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
  // Main prompt textarea (as of early 2025 this is a <div> with
  // contenteditable="true" or a <textarea>).
  // UPDATE THIS if the selector stops matching.
  input: [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'textarea[aria-label*="message" i]',
    'div[contenteditable="true"][data-testid*="composer"]',
    'div.ProseMirror[contenteditable="true"]',
  ],

  // Button that sends the message.
  // UPDATE THIS if the selector stops matching.
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send prompt" i]',
    'button[aria-label*="Send message" i]',
    'button[data-testid*="send"]',
  ],

  // The "Stop generating" button is visible while the AI is streaming.
  // We wait for it to disappear before considering the response done.
  // UPDATE THIS if the selector stops matching.
  stopButton: [
    'button[aria-label="Stop streaming"]',
    'button[aria-label*="Stop" i]',
    '[data-testid*="stop"]',
  ],

  // Blocks holding the assistant's replies. Most specific first — the reader
  // takes the first selector that gained a block after the question was sent.
  // UPDATE THIS if the answers stop being read.
  response: [
    '[data-message-author-role="assistant"]',
    'div[data-testid^="conversation-turn"] div.markdown',
    'div.markdown.prose',
  ],
};

const URL = 'https://chatgpt.com/';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
}

/**
 * Sends a single question to ChatGPT, waits for the answer, and reads it back.
 *
 * @param {import('playwright').Page} page
 * @param {string} question
 * @returns {Promise<{ text: string, links: object[], ok: boolean }>}
 */
async function run(page, question) {
  try {
    // If ChatGPT shows login or human verification, the helper pauses and
    // lets the user solve it manually before retrying the input lookup.
    const inputSelector = await waitForInputReady(page, 'ChatGPT', SELECTORS.input);

    // Counted before sending so the answer can be scoped to THIS question.
    const before = await snapshotResponses(page, SELECTORS.response);

    await typeIntoInput(page, inputSelector, question);

    // Submit — try the send button first, fall back to pressing Enter
    try {
      await clickFirstMatching(page, SELECTORS.sendButton, 5_000);
    } catch {
      logger.debug('[ChatGPT] Send button not found, pressing Enter instead.');
      await page.keyboard.press('Enter');
    }

    await waitForResponseToFinish(page, 'ChatGPT', SELECTORS.stopButton);
    return await readNewResponse(page, 'ChatGPT', SELECTORS.response, before);
  } catch (err) {
    logger.error('[ChatGPT] Error:', err.message);
    return { text: '', links: [], ok: false, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD A NEW BOT:
//   Copy this file to bots/newbot.js, change the URL and SELECTORS,
//   then import and call it inside run_all.js.
// ─────────────────────────────────────────────────────────────────────────────

// SELECTORS is exported so tools/inspect.js can probe them against the live
// page without duplicating the list.
module.exports = { open, run, url: URL, selectors: SELECTORS };
