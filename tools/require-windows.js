'use strict';

// Refuses to build the Windows installer anywhere but Windows.
//
// A macOS cross-build assembles the NSIS uninstaller by hand instead of
// executing it, and has shipped uninstallers with an invalid integrity CRC —
// every install then fails to uninstall or update. Releases build in CI on
// windows-latest; see .github/workflows/release.yml.

if (process.platform !== 'win32' && !process.env.ALLOW_BROKEN_UNINSTALLER) {
  console.error('Windows installers must be built on Windows.');
  console.error('Push a version tag and let the release workflow build it, or run this on a Windows machine.');
  console.error('Set ALLOW_BROKEN_UNINSTALLER=1 only to inspect win-unpacked output; never ship the installer.');
  process.exit(1);
}
