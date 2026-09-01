'use strict';

// Single source of truth for the supported sites. Add a bot here and it
// appears in the UI, the login flow and the runner.

const BOTS = [
  { key: 'chatgpt',    label: 'ChatGPT',    module: require('./chatgpt') },
  { key: 'gemini',     label: 'Gemini',     module: require('./gemini') },
  { key: 'perplexity', label: 'Perplexity', module: require('./perplexity') },
  { key: 'grok',       label: 'Grok',       module: require('./grok') },
  { key: 'meta',       label: 'Meta AI',    module: require('./meta') },
];

/**
 * Normalizes user input ("Meta AI", " ChatGPT ") into a registry key.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * True when `value` names this bot, by key ("meta") or by label ("Meta AI").
 *
 * @param {{ key: string, label: string }} bot
 * @param {string} normalized
 * @returns {boolean}
 */
function matches(bot, normalized) {
  return bot.key === normalized || normalizeKey(bot.label) === normalized;
}

/**
 * Looks up a bot by key or label. Returns null when the name is unknown.
 *
 * @param {string} key
 * @returns {{ key: string, label: string, module: object } | null}
 */
function getBot(key) {
  const normalized = normalizeKey(key);
  return BOTS.find((bot) => matches(bot, normalized)) || null;
}

/**
 * All registry keys, in display order.
 *
 * @returns {string[]}
 */
function allKeys() {
  return BOTS.map((bot) => bot.key);
}

/**
 * Serializable bot list for the web UI (no module references).
 *
 * @returns {{ key: string, label: string }[]}
 */
function listBots() {
  return BOTS.map(({ key, label }) => ({ key, label }));
}

/**
 * The sites to open for a login session — one per bot, taken from the bot's
 * own URL so the login flow can never drift out of sync with what the bots
 * actually visit.
 *
 * @returns {{ label: string, url: string }[]}
 */
function loginSites() {
  return BOTS
    .filter((bot) => typeof bot.module.url === 'string')
    .map((bot) => ({ label: bot.label, url: bot.module.url }));
}

/**
 * Resolves a list of requested keys into bot entries, ignoring unknown ones.
 * Preserves registry order so pages always open in a predictable sequence.
 *
 * @param {string[]} keys
 * @returns {{ key: string, label: string, module: object }[]}
 */
function resolveBots(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return [...BOTS];
  }

  const wanted = keys.map(normalizeKey);
  return BOTS.filter((bot) => wanted.some((name) => matches(bot, name)));
}

module.exports = {
  allKeys,
  getBot,
  listBots,
  loginSites,
  resolveBots,
};
