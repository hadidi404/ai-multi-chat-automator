'use strict';

const { requestManualStep } = require('./pauseController');
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

    // Pauses on stdin in the terminal, or on a "Continue" button in the web UI.
    await requestManualStep({
      botName,
      message: 'Waiting for you: finish the login / verification in the browser window.',
      prompt: `[${botName}] Press ENTER after the chat input is visible... `,
    });

    return await waitForAnySelector(page, selectors, { timeout: 30_000 });
  }
}

/**
 * Clicks the first send button that is both visible AND enabled.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
async function clickFirstMatching(page, selectors, timeout = 5_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();

      try {
        if (await locator.isVisible() && await locator.isEnabled()) {
          await locator.click({ timeout: 5_000 });
          return selector;
        }
      } catch {
        // Detached or re-rendered between the check and the click; try again.
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error(`No enabled send button matched: ${selectors.join(', ')}`);
}

/**
 * Whatever text a composer currently holds, textarea or contenteditable.
 *
 * @param {import('playwright').Locator} locator
 * @returns {Promise<string>}
 */
async function readComposer(locator) {
  try {
    return await locator.evaluate((el) => {
      const value = el.value != null ? el.value : el.innerText;
      return String(value == null ? '' : value);
    });
  } catch {
    return '';
  }
}

/**
 * Types text keystroke by keystroke, breaking lines with Shift+Enter.
 *
 * @param {import('playwright').Page} page
 * @param {string} value
 * @returns {Promise<void>}
 */
async function typeByKeystroke(page, value) {
  const lines = value.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      await page.keyboard.press('Shift+Enter');
    }

    if (lines[index]) {
      await page.keyboard.type(lines[index], { delay: 12 });
    }
  }
}

/**
 * Puts text into a chat composer and confirms it actually arrived.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 * @returns {Promise<void>}
 */
async function typeIntoInput(page, selector, text) {
  const locator = page.locator(selector).first();
  const value = String(text == null ? '' : text);

  await locator.click();

  // Enough of the text to prove it landed, but short enough to survive an
  // editor that reflows or trims what it was given.
  const proof = value.replace(/\s+/g, ' ').trim().slice(0, 24);

  const landed = async () => {
    const current = (await readComposer(locator)).replace(/\s+/g, ' ').trim();
    return proof ? current.includes(proof) : current.length > 0;
  };

  try {
    await locator.fill(value);
  } catch {
    await typeByKeystroke(page, value);
  }

  // Rich editors update their state a tick after the input event; asking
  // immediately can read an empty composer that is about to be filled.
  await page.waitForTimeout(250);

  if (await landed()) {
    return;
  }

  // fill() can be swallowed by an editor that only listens for real key events.
  await locator.click();
  await typeByKeystroke(page, value);
  await page.waitForTimeout(250);

  if (!(await landed())) {
    throw new Error('the text would not go into the chat box');
  }
}

/**
 * Waits for a streaming / stop button to appear and then disappear.
 *
 * @param {import('playwright').Page} page
 * @param {string} botName
 * @param {string[]} selectors
 * @param {{ appearTimeout?: number, finishTimeout?: number }} [options]
 * @returns {Promise<void>}
 */
async function waitForResponseToFinish(page, botName, selectors, options = {}) {
  const appearTimeout = options.appearTimeout ?? 4_000;
  const finishTimeout = options.finishTimeout ?? 120_000;

  logger.debug(`[${botName}] Waiting for response to finish...`);

  try {
    const selector = await waitForAnySelector(page, selectors, { timeout: appearTimeout });
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: finishTimeout });
  } catch {
    logger.debug(`[${botName}] No streaming indicator matched — watching the answer text instead.`);
  }
}

/**
 * Records how many answer blocks are on the page right now.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @returns {Promise<Record<string, number>>}
 */
async function snapshotResponses(page, selectors) {
  const counts = {};

  for (const selector of selectors) {
    try {
      counts[selector] = await page.locator(selector).count();
    } catch {
      counts[selector] = 0;
    }
  }

  return counts;
}

/**
 * Every plausible location for the newest answer, best first.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {Record<string, number>} snapshot
 * @returns {Promise<{ selector: string, from: number, to: number }[]>}
 */
async function findAnswerCandidates(page, selectors, snapshot) {
  const gained = [];
  const reused = [];

  for (const selector of selectors) {
    let count = 0;

    try {
      count = await page.locator(selector).count();
    } catch {
      // A navigation mid-lookup destroys the context; the next poll retries.
      continue;
    }

    if (count === 0) {
      continue;
    }

    const before = snapshot[selector] || 0;

    if (count > before) {
      gained.push({ selector, from: before, to: count, gained: true });
    } else {
      reused.push({ selector, from: count - 1, to: count, gained: false });
    }
  }

  return [...gained, ...reused];
}

/**
 * Pulls the text and links out of a range of answer blocks.
 *
 * @param {import('playwright').Page} page
 * @param {{ selector: string, from: number, to: number }} target
 * @returns {Promise<{ text: string, links: { href: string, label: string }[] }>}
 */
async function readTarget(page, target) {
  const locator = page.locator(target.selector);
  const parts = [];
  const links = [];

  for (let index = target.from; index < target.to; index++) {
    const block = locator.nth(index);

    try {
      parts.push((await block.innerText()).trim());

      const found = await block.locator('a[href]').evaluateAll((nodes) =>
        nodes.map((node) => ({
          href: node.href,
          label: (node.textContent || '').trim().slice(0, 120),
        }))
      );

      links.push(...found);
    } catch {
      // A block can detach mid-read while the page re-renders; skip it.
    }
  }

  return { text: parts.filter(Boolean).join('\n\n').trim(), links };
}

/**
 * Reads the answer that appeared since `snapshot` was taken.
 *
 * @param {import('playwright').Page} page
 * @param {string} botName
 * @param {string[]} selectors
 * @param {Record<string, number>} [snapshot]
 * @param {{ timeout?: number, stableFor?: number, pollInterval?: number }} [options]
 * @returns {Promise<{
 *   text: string,
 *   links: { href: string, label: string }[],
 *   ok: boolean,
 *   reason?: string,
 * }>}
 */
async function readNewResponse(page, botName, selectors, snapshot = {}, options = {}) {
  const timeout = options.timeout ?? 60_000;
  const stableFor = options.stableFor ?? 2_000;
  const pollInterval = options.pollInterval ?? 400;
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  let best = { text: '', links: [] };
  let sawTarget = false;
  let unchangedSince = 0;

  // What was already on screen when we started looking. A block count that
  // never grew is only trustworthy once its text has moved: otherwise the
  // "answer" is the PREVIOUS one, sitting complete and unchanging, which
  // settles instantly and pairs this question with its neighbour's answer.
  let textAtFirstLook = null;

  while (Date.now() < deadline) {
    const candidates = await findAnswerCandidates(page, selectors, snapshot);

    if (candidates.length > 0) {
      sawTarget = true;

      // First candidate that actually has text wins. Without this, one empty
      // wrapper at the top of the list starves every selector below it.
      let current = { text: '', links: [] };

      for (const candidate of candidates) {
        const read = await readTarget(page, candidate);

        if (read.text) {
          // Where this answer lives on the page, so the grid can scroll the
          // user straight to it instead of making them hunt for the question.
          current = { ...read, gained: candidate.gained };
          break;
        }
      }

      if (textAtFirstLook === null) {
        textAtFirstLook = current.text;
      }

      // A gained block is new by definition. A reused one has to prove it is
      // this question's answer by changing since we started watching.
      const isThisAnswer = current.gained || current.text !== textAtFirstLook;

      if (current.text !== best.text) {
        // Still streaming — or still empty. Either way, keep waiting.
        best = current;
        unchangedSince = current.text ? Date.now() : 0;
      } else if (isThisAnswer && current.text && unchangedSince && Date.now() - unchangedSince >= stableFor) {
        const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.debug(`[${botName}] Answer settled at ${current.text.length} characters after ${waited}s.`);

        return { text: current.text, links: current.links, ok: true };
      }
    }

    await page.waitForTimeout(pollInterval);
  }

  // Out of time but we did read something: a long answer that never fully
  // settled is worth more than a blank row.
  if (best.text) {
    logger.warn(`[${botName}] The answer was still changing after ${Math.round(timeout / 1000)}s — taking it as it stands.`);

    return { text: best.text, links: best.links, ok: true };
  }

  if (!sawTarget) {
    logger.warn(`[${botName}] Could not find the answer on screen — no response selector matched.`);
    return { text: '', links: [], ok: false, reason: 'no answer block matched the selectors' };
  }

  logger.warn(`[${botName}] Every matching block was still empty after ${Math.round(timeout / 1000)}s — the response selectors may all be matching the wrong elements.`);
  return {
    text: '',
    links: [],
    ok: false,
    reason: `every matching block was still empty after ${Math.round(timeout / 1000)}s`,
  };
}

module.exports = {
  clickFirstMatching,
  readNewResponse,
  snapshotResponses,
  typeIntoInput,
  waitForInputReady,
  waitForResponseToFinish,
};
