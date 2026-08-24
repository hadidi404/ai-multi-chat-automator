'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Manual-step controller
//
// Some sites interrupt automation with a login form, a cookie consent banner,
// or a "verify you are human" challenge. Only a human can clear those, so the
// bot pauses and asks for help.
//
// server.js installs a handler that shows a "Continue" button on the page and
// waits for the click. It clears the handler when the run ends.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Rejects when the run is cancelled while waiting, which lets the bot pipeline
 * unwind instead of hanging forever on a stopped run.
 *
 * With no handler installed there is nobody to ask, so this fails fast rather
 * than blocking a request thread on input that will never arrive.
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
