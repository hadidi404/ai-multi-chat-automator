'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
// Browser discovery
//
// Chrome first, Brave second, whatever Playwright bundles last.
//
// Both are Chromium underneath and the selectors work the same in either, so
// the order is about what the person already has set up: Chrome is the more
// common install, and Google's sign-in is markedly less suspicious of it.
//
// An explicit BROWSER_PATH always wins — for a portable install, a Chromium
// fork, or a second Chrome channel.
//
// ONE PROFILE, ONE BROWSER:
//   That preference only applies to a profile nobody has signed in to yet.
//   Chromium seals cookie values with a key held in the OS keychain under a
//   name unique to the browser ("Chrome Safe Storage" vs "Brave Safe Storage"),
//   so pointing a different browser at an existing profile leaves every cookie
//   undecryptable — the rows are all still there and every site acts signed
//   out. Once a profile has an owner, we keep using it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when a path exists on disk.
 *
 * @param {string} executablePath
 * @returns {boolean}
 */
function isExistingPath(executablePath) {
  if (!executablePath) {
    return false;
  }

  try {
    return fs.existsSync(executablePath);
  } catch {
    return false;
  }
}

/**
 * Install locations per browser, per platform.
 *
 * @param {'chrome' | 'brave'} browser
 * @returns {string[]}
 */
function candidatesFor(browser) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  if (browser === 'chrome') {
    switch (process.platform) {
      case 'win32':
        return [
          path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
      case 'darwin':
        return [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          path.join(homeDir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        ];
      default:
        return [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/opt/google/chrome/chrome',
        ];
    }
  }

  switch (process.platform) {
    case 'win32':
      return [
        path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ];
    case 'darwin':
      return [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        path.join(homeDir, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
      ];
    default:
      return [
        '/snap/brave/current/opt/brave.com/brave/brave',
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave',
      ];
  }
}

/**
 * The browser to drive, preferring Chrome and falling back to Brave.
 *
 * Priority:
 *   1) BROWSER_PATH — an explicit executable, whatever it is
 *   2) CHROME_PATH, then Chrome's usual install locations
 *   3) BRAVE_PATH / BRAVE_EXECUTABLE_PATH, then Brave's usual locations
 *   4) null — the caller falls back to Playwright's bundled Chromium
 *
 * @returns {{ path: string, name: string } | null}
 */
function resolveBrowser() {
  const override = process.env.BROWSER_PATH;

  if (isExistingPath(override)) {
    return { path: override, name: 'your browser' };
  }

  const chromeEnv = process.env.CHROME_PATH;

  if (isExistingPath(chromeEnv)) {
    return { path: chromeEnv, name: 'Chrome' };
  }

  for (const candidate of candidatesFor('chrome')) {
    if (isExistingPath(candidate)) {
      return { path: candidate, name: 'Chrome' };
    }
  }

  const braveEnv = process.env.BRAVE_PATH || process.env.BRAVE_EXECUTABLE_PATH;

  if (isExistingPath(braveEnv)) {
    return { path: braveEnv, name: 'Brave' };
  }

  for (const candidate of candidatesFor('brave')) {
    if (isExistingPath(candidate)) {
      return { path: candidate, name: 'Brave' };
    }
  }

  return null;
}

/** Remembers which browser owns a profile, so later runs cannot drift. */
const PIN_FILE = '.browser';

/**
 * Which browser created an existing profile, or '' for a fresh one.
 *
 * Prefers the pin we wrote ourselves; falls back to sniffing, because profiles
 * predating the pin still need to be recognised. Brave stamps its own keys
 * through Local State, and the singleton socket points into a
 * com.brave.Browser / com.google.Chrome temp directory.
 *
 * @param {string} userDataDir
 * @returns {string}
 */
function profileOwner(userDataDir) {
  try {
    const pinned = fs.readFileSync(path.join(userDataDir, PIN_FILE), 'utf-8').trim();

    if (pinned) {
      return pinned;
    }
  } catch {
    // No pin yet — fall through and sniff.
  }

  try {
    if (!fs.existsSync(path.join(userDataDir, 'Default'))) {
      return '';
    }
  } catch {
    return '';
  }

  try {
    const socket = fs.readlinkSync(path.join(userDataDir, 'SingletonSocket'));

    if (socket.includes('com.brave.Browser')) {
      return 'Brave';
    }

    if (socket.includes('com.google.Chrome')) {
      return 'Chrome';
    }
  } catch {
    // No socket (clean shutdown, or Windows) — try Local State instead.
  }

  try {
    const localState = fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf-8');
    return localState.includes('"brave"') ? 'Brave' : 'Chrome';
  } catch {
    return '';
  }
}

/** Records the owner so the next launch does not have to sniff. */
function pinProfileOwner(userDataDir, name) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, PIN_FILE), `${name}\n`, 'utf-8');
  } catch {
    // Not worth failing a run over; sniffing still works next time.
  }
}

/**
 * The browser to use for a given profile — the ONLY resolver callers should
 * use, so signing in and running questions can never pick different browsers.
 *
 * A profile with an owner keeps it. A fresh profile takes the preferred
 * browser and is pinned to it.
 *
 * @param {string} userDataDir
 * @returns {{ path: string, name: string, owner: string } | null}
 */
function resolveBrowserForProfile(userDataDir) {
  const owner = profileOwner(userDataDir);
  const preferred = resolveBrowser();

  if (!owner) {
    if (preferred) {
      pinProfileOwner(userDataDir, preferred.name);
    }

    return preferred ? { ...preferred, owner: preferred.name } : null;
  }

  // An override is the user saying they know; honour it, but say what it costs.
  if (process.env.BROWSER_PATH && preferred) {
    if (preferred.name !== owner) {
      logger.warn(`BROWSER_PATH overrides the profile's browser (${owner}). Saved logins will not carry over.`);
    }

    return { ...preferred, owner };
  }

  const ownerCandidates = owner === 'Brave' ? candidatesFor('brave') : candidatesFor('chrome');
  const envPath = owner === 'Brave'
    ? (process.env.BRAVE_PATH || process.env.BRAVE_EXECUTABLE_PATH)
    : process.env.CHROME_PATH;

  if (isExistingPath(envPath)) {
    return { path: envPath, name: owner, owner };
  }

  for (const candidate of ownerCandidates) {
    if (isExistingPath(candidate)) {
      return { path: candidate, name: owner, owner };
    }
  }

  // The owning browser is gone. Anything else can launch, but not read the
  // cookies it left behind, so say so rather than looking mysteriously logged out.
  logger.warn(`This profile was created by ${owner}, which is no longer installed.`);
  logger.warn('Sign-ins saved by it cannot be read by another browser — you will need to sign in again.');

  return preferred ? { ...preferred, owner } : null;
}

module.exports = { resolveBrowserForProfile };
