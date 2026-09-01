'use strict';

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT, dataPath } = require('./paths');

// Uploads a pasted screenshot to a Drive folder and returns a shareable link.
//
// Uses the drive.file scope, which grants access only to files this app
// creates. Credentials live in drive-client.json, tokens in drive-config.json.

// Bundled credentials are read first, so a distributed copy arrives ready to
// connect; anything entered by hand is written to the data folder instead.
const SHIPPED_CLIENT_FILE = path.join(PROJECT_ROOT, 'drive-client.json');
const CLIENT_FILE = dataPath('drive-client.json');
const CONFIG_FILE = dataPath('drive-config.json');
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';

/** Cached access token — short lived, never written to disk. */
let accessToken = null;
let accessTokenExpiry = 0;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * The OAuth app credentials. A shipped drive-client.json wins, so a teammate
 * only has to click Connect. Anything pasted into the UI is the fallback.
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

  const local = readJson(CONFIG_FILE);
  return {
    clientId: local.clientId || '',
    clientSecret: local.clientSecret || '',
    preconfigured: false,
  };
}

function readConfig() {
  return readJson(CONFIG_FILE);
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/**
 * Pulls the folder id out of whatever the user pasted — a full folder URL, a
 * sharing link with query junk, or the bare id.
 *
 * @param {string} value
 * @returns {string}
 */
function parseFolderId(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  const fromPath = raw.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (fromPath) {
    return fromPath[1];
  }

  const fromQuery = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (fromQuery) {
    return fromQuery[1];
  }

  // A bare id: Drive ids are long and have no slashes or spaces.
  return /^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : '';
}

/**
 * What the UI needs to render the Drive panel. Never returns the secret.
 *
 * @returns {{ hasClient: boolean, connected: boolean, folderId: string, folderSet: boolean }}
 */
function status() {
  const config = readConfig();
  const client = readClient();

  return {
    hasClient: Boolean(client.clientId && client.clientSecret),
    // True when credentials shipped with the app, so the UI can hide them.
    preconfigured: client.preconfigured,
    connected: Boolean(config.refreshToken),
    folderId: config.folderId || '',
    folderSet: Boolean(config.folderId),
  };
}

/**
 * Saves the OAuth app credentials into drive-client.json — the file that ships
 * with the folder. Setting up here once is what lets teammates skip straight to
 * "Connect".
 */
function saveClient({ clientId, clientSecret }) {
  const next = {
    clientId: String(clientId || '').trim(),
    clientSecret: String(clientSecret || '').trim(),
  };

  fs.writeFileSync(CLIENT_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

function saveFolder(value) {
  const folderId = parseFolderId(value);

  if (!folderId) {
    throw new Error('That does not look like a Drive folder link. Open the folder in Drive and copy the URL from the address bar.');
  }

  writeConfig({ folderId });
  return folderId;
}

function disconnect() {
  accessToken = null;
  accessTokenExpiry = 0;
  writeConfig({ refreshToken: null });
}

/**
 * The Google consent URL to send the user to.
 *
 * @param {string} redirectUri
 * @returns {string}
 */
function buildAuthUrl(redirectUri) {
  const { clientId } = readClient();

  if (!clientId) {
    throw new Error('Add your OAuth Client ID and Client Secret first.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Without this Google skips the refresh token on repeat authorisations.
    prompt: 'consent',
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

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

/**
 * Trades the one-time code from the consent redirect for a refresh token.
 *
 * @param {string} code
 * @param {string} redirectUri
 */
async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = readClient();

  const data = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.');
  }

  writeConfig({ refreshToken: data.refresh_token });
  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
}

/**
 * A valid access token, refreshed when the cached one is close to expiring.
 *
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry) {
    return accessToken;
  }

  const { refreshToken } = readConfig();
  const { clientId, clientSecret } = readClient();

  if (!refreshToken) {
    throw new Error('Google Drive is not connected yet.');
  }

  let data;

  try {
    data = await postForm(TOKEN_ENDPOINT, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // While the OAuth consent screen is in Testing, Google expires refresh
    // tokens after 7 days and then answers invalid_grant. Clear the dead token
    // so the UI shows "not connected" instead of failing every upload.
    if (String(err.message || '').includes('invalid_grant')) {
      disconnect();
      throw new Error('Google Drive sign-in expired — click Connect to sign in again.');
    }

    throw err;
  }

  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

/**
 * Uploads one image and returns a link anyone can open.
 *
 * @param {{ buffer: Buffer, mimeType: string, name: string }} file
 * @returns {Promise<{ id: string, link: string }>}
 */
async function uploadImage({ buffer, mimeType, name }) {
  const { folderId } = readConfig();

  if (!folderId) {
    throw new Error('Set the Drive folder first.');
  }

  const token = await getAccessToken();
  const boundary = `sshot${Date.now().toString(36)}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });

  // Multipart upload: metadata part, then the raw bytes.
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await fetch(`${UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = (data.error && data.error.message) || `Drive returned ${response.status}`;
    throw new Error(`Upload failed: ${reason}`);
  }

  // The sheet is shared with people who are not us, so the link has to work
  // for them too.
  await fetch(`${FILES_ENDPOINT}/${data.id}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch(() => {
    // A failed share still leaves a usable file; the link just needs manual
    // sharing. Not worth failing the whole paste over.
  });

  return {
    id: data.id,
    link: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
  };
}

module.exports = {
  buildAuthUrl,
  disconnect,
  exchangeCode,
  saveClient,
  saveFolder,
  status,
  uploadImage,
};
