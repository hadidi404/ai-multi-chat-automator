'use strict';

const { waitForEnter } = require('./waitForEnter');
const logger = require('./logger');

/**
 * Waits until any selector in the list becomes visible.
 * Returns the first selector that matches.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {{ timeout?: number, pollInterval?: number }} [options]
 * @returns {Promise<string>}
 */
async function waitForAnySelector(page, selectors, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const pollInterval = options.pollInterval ?? 250;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();

      try {
        if (await locator.isVisible()) {
          return selector;
        }
      } catch {
        // Ignore transient DOM lookup issues while polling.
      }
    }

    await page.waitForTimeout(pollInterval);
  }

  throw new Error(`Timed out waiting for selectors: ${selectors.join(', ')}`);
}

/**
 * Waits for the chat input and, if necessary, gives the user time to solve
 * login / consent / CAPTCHA / "verify you are human" screens manually.
 *
 * @param {import('playwright').Page} page
 * @param {string} botName
 * @param {string[]} selectors
 * @returns {Promise<string>}
 */
async function waitForInputReady(page, botName, selectors) {
  logger.debug(`[${botName}] Waiting for input box...`);

  try {
    return await waitForAnySelector(page, selectors, { timeout: 30_000 });
  } catch {
    logger.warn(`[${botName}] Input box not found yet.`);
    logger.warn(`[${botName}] If the site is showing login, consent, or a human-verification challenge, complete it manually in the browser.`);
    await waitForEnter(`[${botName}] Press ENTER after the chat input is visible... `);
    return await waitForAnySelector(page, selectors, { timeout: 30_000 });
  }
}

/**
 * Clicks the first visible selector from a list.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
async function clickFirstMatching(page, selectors, timeout = 5_000) {
  const selector = await waitForAnySelector(page, selectors, { timeout });
  await page.locator(selector).first().click();
  return selector;
}

/**
 * Types into either a textarea/input or a contenteditable element.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 * @returns {Promise<void>}
 */
async function typeIntoInput(page, selector, text) {
  const locator = page.locator(selector).first();
  await locator.click();

  const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());

  if (tagName === 'textarea' || tagName === 'input') {
    await locator.fill(text);
    return;
  }

  await page.keyboard.type(text);
}

/**
 * Waits for a streaming / stop button to appear and then disappear.
 * Falls back to a short fixed delay if the selector never matches.
 *
 * @param {import('playwright').Page} page
 * @param {string} botName
 * @param {string[]} selectors
 * @returns {Promise<void>}
 */
async function waitForResponseToFinish(page, botName, selectors) {
  logger.debug(`[${botName}] Waiting for response to finish...`);

  try {
    const selector = await waitForAnySelector(page, selectors, { timeout: 10_000 });
    await page.locator(selector).first().waitFor({
      state: 'hidden',
      timeout: 120_000,
    });
  } catch {
    logger.debug(`[${botName}] Response-finished selector did not match, waiting 8 s as fallback.`);
    await page.waitForTimeout(8_000);
  }
}

module.exports = {
  clickFirstMatching,
  typeIntoInput,
  waitForAnySelector,
  waitForInputReady,
  waitForResponseToFinish,
};