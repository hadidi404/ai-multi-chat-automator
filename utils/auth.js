'use strict';

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT, dataPath } = require('./paths');
const { AUTH_ENDPOINT, TOKEN_ENDPOINT, postForm, readClient, readJson } = require('./googleClient');

// Restricts the app to one Google Workspace domain.
//
// The domain comes from app-config.json, which is built into the app. That
// matters: the per-machine fallback below is set by whoever signs in first on
// that machine, so on its own it restricts nothing — a stranger's install
// would simply fix itself to the stranger's domain.
//
// The other half is the consent screen being Internal, which stops Google
// issuing a token to an outside account at all. This check is what survives
// the app being switched to External.

const CONFIG_FILE = path.join(PROJECT_ROOT, 'app-config.json');
const ACCESS_FILE = dataPath('access.json');
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file';

let session = null;

function readAccess() {
  return readJson(ACCESS_FILE);
}

function writeAccess(patch) {
  const next = { ...readAccess(), ...patch };
  fs.writeFileSync(ACCESS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

/**
 * The domain this copy is fixed to, or '' while unclaimed.
 *
 * The built-in value wins. Only a build without one falls back to the domain
 * of the first account to sign in, which is a development convenience, not a
 * restriction.
 *
 * @returns {string}
 */
function allowedDomain() {
  const configured = String(readJson(CONFIG_FILE).allowedDomain || '').trim().toLowerCase();
  return configured || String(readAccess().domain || '').trim().toLowerCase();
}

/**
 * Reads the claims out of a Google ID token.
 *
 * The signature is not verified because the token came straight from Google's
 * token endpoint over TLS, in response to our own request.
 *
 * @param {string} idToken
 * @returns {object}
 */
function decodeIdToken(idToken) {
  const payload = String(idToken || '').split('.')[1];

  if (!payload) {
    return {};
  }

  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * The consent URL to send the user to.
 *
 * @param {string} redirectUri
 * @returns {string}
 */
function buildSignInUrl(redirectUri) {
  const { clientId } = readClient();

  if (!clientId) {
    throw new Error('This copy has no Google credentials configured.');
  }

  const domain = allowedDomain();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: 'signin',
    // Filters the account chooser to the right domain instead of rejecting
    // the wrong account afterwards.
    ...(domain ? { hd: domain } : {}),
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Completes a sign-in and decides whether the account is allowed in.
 *
 * @param {string} code
 * @param {string} redirectUri
 * @returns {Promise<{ email: string, domain: string }>}
 */
async function completeSignIn(code, redirectUri) {
  const { clientId, clientSecret } = readClient();

  const data = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const claims = decodeIdToken(data.id_token);
  const email = String(claims.email || '').trim().toLowerCase();

  if (!email) {
    throw new Error('Google did not say which account that was. Try signing in again.');
  }

  // hd is Google's own answer to which Workspace an account belongs to. A
  // personal account has none, which is the case to reject.
  if (!claims.hd) {
    throw new Error('That is a personal Google account. Use your work account.');
  }

  const domain = String(claims.hd).trim().toLowerCase();
  const locked = allowedDomain();

  if (locked && domain !== locked) {
    throw new Error(`This app is limited to @${locked} accounts. ${email} is not one.`);
  }

  writeAccess({
    domain,
    email,
    signedInAt: Date.now(),
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
  });

  session = { email, domain };
  return { email, domain };
}

/**
 * Who is signed in, if anyone.
 *
 * @returns {{ signedIn: boolean, email: string, domain: string }}
 */
function status() {
  if (!session) {
    const saved = readAccess();

    if (saved.email && saved.domain) {
      session = { email: saved.email, domain: saved.domain };
    }
  }

  return {
    signedIn: Boolean(session),
    email: session ? session.email : '',
    domain: session ? session.domain : allowedDomain(),
  };
}

/** Signs out, keeping the domain: that belongs to the copy, not the person. */
function signOut() {
  session = null;
  writeAccess({ email: '', refreshToken: '', signedInAt: 0 });
}

/**
 * Asks Google whether the stored account is still valid, and signs out if not.
 *
 * Google answers invalid_grant once a token is revoked, a password changes, or
 * an account is suspended or deleted, so this is what makes removing someone
 * from the Workspace take effect here. Any other failure — offline, proxy,
 * Google unreachable — leaves the session alone rather than locking out
 * someone whose only problem is the network.
 *
 * @returns {Promise<{ valid: boolean, checked: boolean }>}
 */
async function revalidate() {
  const { refreshToken } = readAccess();

  if (!refreshToken) {
    return { valid: false, checked: false };
  }

  const { clientId, clientSecret } = readClient();

  if (!clientId || !clientSecret) {
    return { valid: true, checked: false };
  }

  try {
    await postForm(TOKEN_ENDPOINT, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    return { valid: true, checked: true };
  } catch (err) {
    if (/invalid_grant/i.test(String(err.message || ''))) {
      signOut();
      return { valid: false, checked: true };
    }

    return { valid: true, checked: false };
  }
}

module.exports = {
  allowedDomain,
  buildSignInUrl,
  completeSignIn,
  revalidate,
  signOut,
  status,
};
