'use strict';

const {
  waitForInputReady,
  typeIntoInput,
  clickFirstMatching,
  waitForResponseToFinish,
} = require('../utils/botHelpers');

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

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

async function run(page, question) {
  const inputSelector = await waitForInputReady(page, 'Gemini', INPUT_SELECTORS);
  const input = page.locator(inputSelector).first();

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
}

module.exports = { open, run };
