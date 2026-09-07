'use strict';

// Verifies that the uninstaller embedded in an NSIS installer passes NSIS's
// own integrity check, without installing anything.
//
// Exists because a macOS cross-build assembles the uninstaller by hand and can
// produce one whose stored CRC does not match its bytes. Windows then refuses
// to run it ("Installer integrity check has failed"), which breaks both
// uninstalling and every subsequent auto-update. The CRC covers the file from
// byte 512 to the last four bytes, which hold the stored value.
//
// Usage: node tools/verify-nsis-uninstaller.js <Setup.exe | dist directory>
// Exits non-zero if the installer or its embedded uninstaller fails the check.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIGNATURE = Buffer.from([
  0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c,
  0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74,
]);

const CRC_SKIP = 512;

/**
 * Verifies the NSIS CRC of one executable image.
 *
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, stored: string, computed: string, uninstaller: boolean }}
 */
function verify(buffer) {
  const headerOffset = buffer.indexOf(SIGNATURE) - 4;

  if (headerOffset < 0) {
    throw new Error('no NSIS header found');
  }

  const flags = buffer.readUInt32LE(headerOffset);
  const totalLength = buffer.readUInt32LE(headerOffset + 24);
  const end = headerOffset + totalLength;
  const stored = buffer.readUInt32LE(end - 4) >>> 0;
  const computed = zlib.crc32(buffer.subarray(CRC_SKIP, end - 4)) >>> 0;

  return {
    ok: stored === computed,
    stored: stored.toString(16).padStart(8, '0'),
    computed: computed.toString(16).padStart(8, '0'),
    uninstaller: (flags & 1) === 1,
  };
}

/**
 * Finds the uninstaller inside an installer's datablock stream: the one
 * embedded executable that carries an NSIS header of its own.
 *
 * @param {Buffer} setup
 * @returns {Buffer}
 */
function extractUninstaller(setup) {
  const headerOffset = setup.indexOf(SIGNATURE) - 4;
  let position = headerOffset + 28;

  while (position + 4 <= setup.length) {
    const raw = setup.readUInt32LE(position);
    const size = raw & 0x7fffffff;

    if (size === 0 || position + 4 + size > setup.length) {
      break;
    }

    let payload = setup.subarray(position + 4, position + 4 + size);
    position += 4 + size;

    if ((raw & 0x80000000) !== 0) {
      try {
        payload = zlib.inflateRawSync(payload);
      } catch {
        continue;
      }
    }

    if (payload[0] === 0x4d && payload[1] === 0x5a && payload.indexOf(SIGNATURE) !== -1) {
      return payload;
    }
  }

  throw new Error('no embedded uninstaller found');
}

function resolveInstaller(target) {
  const stat = fs.statSync(target);

  if (stat.isFile()) {
    return target;
  }

  const candidates = fs.readdirSync(target)
    .filter((name) => name.endsWith('.exe') && !name.startsWith('__'))
    .map((name) => path.join(target, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`no installer .exe found in ${target}`);
  }

  return candidates[0];
}

const installerPath = resolveInstaller(process.argv[2] || 'dist');
const setup = fs.readFileSync(installerPath);

console.log(`Checking ${installerPath} (${setup.length} bytes)`);

const installer = verify(setup);
console.log(`  installer   CRC stored ${installer.stored} computed ${installer.computed} -> ${installer.ok ? 'ok' : 'FAILED'}`);

const embedded = extractUninstaller(setup);
const uninstaller = verify(embedded);
console.log(`  uninstaller CRC stored ${uninstaller.stored} computed ${uninstaller.computed} -> ${uninstaller.ok ? 'ok' : 'FAILED'} (${embedded.length} bytes${uninstaller.uninstaller ? '' : ', missing uninstaller flag'})`);

if (!installer.ok || !uninstaller.ok || !uninstaller.uninstaller) {
  console.error('\nThis installer would fail on user machines. Do not publish it.');
  process.exit(1);
}

console.log('\nInstaller and embedded uninstaller both pass the NSIS integrity check.');
