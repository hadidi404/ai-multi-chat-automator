'use strict';

const readline = require('readline');

/**
 * Pauses execution and waits for the user to press Enter.
 * Useful for manual checkpoints (login/CAPTCHA/consent flows).
 *
 * @param {string} [prompt='Press ENTER to continue...']
 * @returns {Promise<void>}
 */
function waitForEnter(prompt = 'Press ENTER to continue...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

module.exports = { waitForEnter };
