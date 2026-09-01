'use strict';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function resolveLevel(levelValue) {
  const normalized = String(levelValue || 'info').trim().toLowerCase();
  return LEVELS[normalized] ? normalized : 'info';
}

const currentLevel = resolveLevel(process.env.LOG_LEVEL);

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

// Sinks receive every level regardless of LOG_LEVEL; the web UI does its own
// filtering.

/** @type {Set<(level: string, message: string) => void>} */
const sinks = new Set();

/**
 * Registers a log destination. Returns a function that removes it again.
 *
 * @param {(level: string, message: string) => void} sink
 * @returns {() => void}
 */
function addSink(sink) {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function formatArg(arg) {
  if (typeof arg === 'string') {
    return arg;
  }

  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function emit(level, args) {
  if (sinks.size === 0) {
    return;
  }

  const message = args.map(formatArg).join(' ');

  for (const sink of sinks) {
    // A broken sink (e.g. a disconnected browser tab) must never take down a run.
    try {
      sink(level, message);
    } catch {
      // Ignore sink failures.
    }
  }
}

function debug(...args) {
  emit('debug', args);
  if (shouldLog('debug')) {
    console.log(...args);
  }
}

function info(...args) {
  emit('info', args);
  if (shouldLog('info')) {
    console.log(...args);
  }
}

function warn(...args) {
  emit('warn', args);
  if (shouldLog('warn')) {
    console.warn(...args);
  }
}

function error(...args) {
  emit('error', args);
  if (shouldLog('error')) {
    console.error(...args);
  }
}

module.exports = {
  addSink,
  debug,
  info,
  warn,
  error,
};
