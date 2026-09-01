'use strict';

const fs = require('fs');
const path = require('path');

// Bundled code is read-only once packaged, so anything the app writes has to
// live elsewhere. The desktop shell sets AI_MULTI_CHAT_DATA; without it the
// project root is used.

const PROJECT_ROOT = path.join(__dirname, '..');

const DATA_DIR = process.env.AI_MULTI_CHAT_DATA
  ? path.resolve(process.env.AI_MULTI_CHAT_DATA)
  : PROJECT_ROOT;

/**
 * A path inside the data folder, with the folder created if needed.
 *
 * @param {...string} parts
 * @returns {string}
 */
function dataPath(...parts) {
  const full = path.join(DATA_DIR, ...parts);

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
  } catch {
    // A failed mkdir surfaces on the read or write itself, with a better message.
  }

  return full;
}

module.exports = { DATA_DIR, PROJECT_ROOT, dataPath };
