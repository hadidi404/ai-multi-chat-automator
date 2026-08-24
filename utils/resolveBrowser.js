'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = { resolveBrowser };
