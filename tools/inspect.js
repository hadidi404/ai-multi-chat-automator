'use strict';

const fs = require('fs');
const path = require('path');

const { getBot, listBots } = require('../bots');
const { launchBrowserContext } = require('../utils/session');
const { clickFirstMatching, typeIntoInput, waitForInputReady } = require('../utils/botHelpers');

// Sends one question to one bot and records what each selector matches over
// time. Used to work out why an answer was not read.
//
// Usage: node tools/inspect.js perplexity "a question"

const WATCH_MS = 75_000;
const TICK_MS = 500;
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

/** Every line goes to the console and the report file at once. */
function makeReport(file) {
  const lines = [];

  return {
    log(line = '') {
      console.log(line);
      lines.push(line);
    },
    save() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
    },
  };
}

/**
 * How many elements match, and how much text sits inside them right now.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<{ count: number, chars: number, sample: string, error?: string }>}
 */
async function probe(page, selector) {
  try {
    const locator = page.locator(selector);
    const count = await locator.count();

    if (count === 0) {
      return { count: 0, chars: 0, sample: '' };
    }

    const last = locator.nth(count - 1);
    const text = ((await last.innerText()) || '').trim();

    return { count, chars: text.length, sample: text.slice(0, 60).replace(/\s+/g, ' ') };
  } catch (err) {
    return { count: -1, chars: -1, sample: '', error: err.message.split('\n')[0] };
  }
}

/**
 * True when any of the stop/streaming selectors is visible — the signal
 * waitForResponseToFinish trusts.
 */
async function stopVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      if (await page.locator(selector).first().isVisible()) {
        return selector;
      }
    } catch {
      // Ignore — a missing element is simply not visible.
    }
  }

  return '';
}

async function main() {
  const [key, ...rest] = process.argv.slice(2);
  const question = rest.join(' ').trim() || 'What are the best coffee shops in Baguio?';
  const entry = key ? getBot(key) : null;

  if (!entry) {
    console.error(`Usage: node tools/inspect.js <bot> "<question>"`);
    console.error(`Bots:  ${listBots().map((bot) => bot.key).join(', ')}`);
    process.exit(1);
  }

  const selectors = entry.module.selectors;

  if (!selectors) {
    console.error(`${entry.label} does not export its selectors.`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(DEBUG_DIR, `${entry.key}-${stamp}`);
  const report = makeReport(`${base}.log`);

  report.log(`${entry.label} selector inspection`);
  report.log(`question: ${question}`);
  report.log(`when:     ${new Date().toString()}`);
  report.log('');

  const context = await launchBrowserContext();
  const page = context.pages()[0] || await context.newPage();

  try {
    await entry.module.open(page);
    report.log(`opened ${entry.module.url}`);

    const inputSelector = await waitForInputReady(page, entry.label, selectors.input);
    report.log(`input matched: ${inputSelector}`);

    // What is already on the page before we ask anything. A non-zero count here
    // is what the reader treats as "existing" when scoping the new answer.
    report.log('');
    report.log('BEFORE sending:');
    for (const selector of selectors.response) {
      const state = await probe(page, selector);
      report.log(`  ${selector}  ->  count=${state.count} chars=${state.chars}`);
    }

    await typeIntoInput(page, inputSelector, question);

    try {
      const clicked = await clickFirstMatching(page, selectors.sendButton, 5_000);
      report.log(`\nsent via button: ${clicked}`);
    } catch {
      await page.keyboard.press('Enter');
      report.log('\nsent via Enter (no send button matched)');
    }

    report.log('');
    report.log(`watching for ${WATCH_MS / 1000}s — "stop" is the streaming indicator, counts/chars are per response selector`);
    report.log('');

    const header = ['   t', 'stop'.padEnd(28)]
      .concat(selectors.response.map((selector) => selector.slice(0, 26).padEnd(28)))
      .join(' ');
    report.log(header);
    report.log('-'.repeat(header.length));

    const startedAt = Date.now();
    let lastSignature = '';

    while (Date.now() - startedAt < WATCH_MS) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(4);
      const stop = await stopVisible(page, selectors.stopButton);

      const cells = [];
      for (const selector of selectors.response) {
        const state = await probe(page, selector);
        cells.push(
          state.error
            ? `ERR ${state.error.slice(0, 22)}`.padEnd(28)
            : `count=${state.count} chars=${state.chars}`.padEnd(28)
        );
      }

      const signature = `${stop}|${cells.join('')}`;

      // Only print when something actually changed — a 75 s watch is otherwise
      // 150 identical rows nobody will read.
      if (signature !== lastSignature) {
        report.log([elapsed, (stop ? `VISIBLE ${stop.slice(0, 19)}` : '-').padEnd(28)].concat(cells).join(' '));
        lastSignature = signature;
      }

      await page.waitForTimeout(TICK_MS);
    }

    report.log('');
    report.log('FINAL text of the last block, per selector:');

    for (const selector of selectors.response) {
      const state = await probe(page, selector);
      report.log('');
      report.log(`  ${selector}`);
      report.log(`    count=${state.count} chars=${state.chars}`);
      report.log(`    starts: ${state.sample || '(empty)'}`);
    }

    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    report.log('');
    report.log(`screenshot: ${base}.png`);
  } catch (err) {
    report.log('');
    report.log(`FAILED: ${err.message}`);
  } finally {
    report.save();
    console.log(`\nReport written to ${base}.log`);
    console.log('The browser stays open so you can inspect the page yourself. Close it when done.');
  }
}

// Guarded so importing this file cannot start a browser as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
