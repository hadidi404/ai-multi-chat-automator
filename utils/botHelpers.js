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
 * Multi-line text is typed line by line with Shift+Enter between lines. Every
 * one of these chat boxes sends on a bare Enter, so typing a "\n" straight
 * through would fire the message off half-written and post the rest as
 * separate messages.
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
  const lines = String(text == null ? '' : text).split(/\r?\n/);

  if (tagName === 'textarea' || tagName === 'input') {
    await locator.fill(lines.join('\n'));
    return;
  }

  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      await page.keyboard.press('Shift+Enter');
    }

    if (lines[index]) {
      await page.keyboard.type(lines[index]);
    }
  }
}

/**
 * Waits for a streaming / stop button to appear and then disappear.
 *
 * This is the FAST path, not the authority: when a site shows a stop button we
 * know the instant streaming ends, so the answer can be read immediately.
 * When no selector matches we give up quickly rather than burning a fixed
 * delay — readNewResponse decides the answer is done by watching the text,
 * which needs no selector to be right.
 *
 * A blanket sleep here used to cost every question on a site with no matching
 * indicator ~18 s of dead time (10 s waiting for a button that never comes,
 * then 8 s of "just in case") while sites like ChatGPT paid none of it.
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
 * Call this BEFORE sending a question. After the answer arrives, the blocks
 * beyond these counts are the new answer — which is how a question's result is
 * scoped to that question instead of scraping the whole conversation.
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
 * Returns a LIST rather than one winner because a selector matching is not the
 * same as a selector holding the answer: Perplexity's `[id^="markdown-content"]`
 * matches an element that is never rendered, so its innerText is permanently
 * empty while the real answer sits in `.prose`. Handing back every candidate
 * lets the reader skip the empty ones instead of waiting out its timeout on a
 * block that will never fill.
 *
 * Selectors that GAINED blocks come first, in selector order, since a new block
 * is the strongest evidence of a new answer. Selectors that merely still match
 * follow, scoped to their last block — the site reuses one container, or the
 * page navigated and the counts reset.
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
      gained.push({ selector, from: before, to: count });
    } else {
      reused.push({ selector, from: count - 1, to: count });
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
 * Polls until the answer text stops changing rather than reading once. The
 * stop-button wait before this is only as good as its selector, and when it
 * misses it degrades to a flat 8-second delay — which is not enough for a site
 * that searches before it writes (Perplexity), leaving a container that is on
 * screen but still empty. Waiting on the text itself needs no selector to be
 * right, and re-finding the target every poll survives a mid-answer navigation.
 *
 * @param {import('playwright').Page} page
 * @param {string} botName
 * @param {string[]} selectors
 * @param {Record<string, number>} [snapshot]
 * @param {{ timeout?: number, stableFor?: number, pollInterval?: number }} [options]
 * @returns {Promise<{ text: string, links: { href: string, label: string }[], ok: boolean, reason?: string }>}
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
          current = read;
          break;
        }
      }

      if (current.text !== best.text) {
        // Still streaming — or still empty. Either way, keep waiting.
        best = current;
        unchangedSince = current.text ? Date.now() : 0;
      } else if (current.text && unchangedSince && Date.now() - unchangedSince >= stableFor) {
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
  findAnswerCandidates,
  readNewResponse,
  snapshotResponses,
  typeIntoInput,
  waitForAnySelector,
  waitForInputReady,
  waitForResponseToFinish,
};