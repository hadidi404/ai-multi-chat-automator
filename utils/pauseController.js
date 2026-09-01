'use strict';

// Lets a bot pause mid-run and wait for the user, either on stdin or on a
// button in the web UI.

/** @type {((request: { botName: string, message: string, prompt: string }) => Promise<void>) | null} */
let handler = null;

/**
 * Installs the handler used to pause for manual intervention.
 * Pass null to clear it.
 *
 * @param {((request: { botName: string, message: string, prompt: string }) => Promise<void>) | null} fn
 */
function setManualStepHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

/**
 * Pauses this bot until a human says it can continue.
 *
 * @param {{ botName: string, message: string, prompt: string }} request
 * @returns {Promise<void>}
 */
async function requestManualStep(request) {
  if (!handler) {
    throw new Error(
      `[${request.botName}] needs a human (login or verification) but nothing is listening. `
      + 'Run this through the web app so the Continue button can appear.'
    );
  }

  return handler(request);
}

module.exports = { requestManualStep, setManualStepHandler };
