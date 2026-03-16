'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Returns true when a path exists and is executable file-like on disk.
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
 * Resolves a best-effort Brave executable path across OSes.
 * Priority:
 *   1) BRAVE_PATH / BRAVE_EXECUTABLE_PATH environment variable
 *   2) Known OS-specific install locations
 *
 * Returns null if not found.
 *
 * @returns {string | null}
 */
function resolveBravePath() {
  const envPath = process.env.BRAVE_PATH || process.env.BRAVE_EXECUTABLE_PATH;
  if (isExistingPath(envPath)) {
    return envPath;
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const candidates = [];

  switch (process.platform) {
    case 'win32':
      candidates.push(
        path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
      );
      break;

    case 'darwin':
      candidates.push(
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        path.join(homeDir, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser')
      );
      break;

    default:
      // Linux and other Unix-like systems
      candidates.push(
        '/snap/brave/current/opt/brave.com/brave/brave',
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave'
      );
      break;
  }

  for (const candidate of candidates) {
    if (isExistingPath(candidate)) {
      return candidate;
    }
  }

  return null;
}

module.exports = { resolveBravePath };