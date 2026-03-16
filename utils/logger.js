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

function debug(...args) {
  if (shouldLog('debug')) {
    console.log(...args);
  }
}

function info(...args) {
  if (shouldLog('info')) {
    console.log(...args);
  }
}

function warn(...args) {
  if (shouldLog('warn')) {
    console.warn(...args);
  }
}

function error(...args) {
  if (shouldLog('error')) {
    console.error(...args);
  }
}

module.exports = {
  debug,
  info,
  warn,
  error,
  currentLevel,
};
