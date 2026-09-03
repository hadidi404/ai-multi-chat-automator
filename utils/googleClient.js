'use strict';

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT, dataPath } = require('./paths');

// One OAuth app, used both to upload screenshots and to decide who may open
// the app. Bundled credentials are read first, so a distributed copy arrives
// ready to use; anything entered by hand is written to the data folder.

const SHIPPED_CLIENT_FILE = path.join(PROJECT_ROOT, 'drive-client.json');
const CLIENT_FILE = dataPath('drive-client.json');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Reads a JSON file, treating anything unreadable as absent.
 *
 * @param {string} file
 * @returns {object}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * The OAuth app credentials.
 *
 * @returns {{ clientId: string, clientSecret: string, preconfigured: boolean }}
 */
function readClient() {
  for (const file of [SHIPPED_CLIENT_FILE, CLIENT_FILE]) {
    const found = readJson(file);

    if (found.clientId && found.clientSecret) {
      return { clientId: found.clientId, clientSecret: found.clientSecret, preconfigured: true };
    }
  }

  return { clientId: '', clientSecret: '', preconfigured: false };
}

/**
 * POSTs a form to Google, raising Google's own error text on failure.
 *
 * @param {string} url
 * @param {object} body
 * @returns {Promise<object>}
 */
async function postForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Google returned ${response.status}`);
  }

  return data;
}

module.exports = {
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  postForm,
  readClient,
  readJson,
};
