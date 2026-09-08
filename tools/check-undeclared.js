'use strict';

// Flags assignments to variables that were never declared.
//
// Under 'use strict' these throw ReferenceError, but only when the line
// actually runs — so `node --check` parses them happily and the failure
// surfaces in front of a user instead. A refactor once deleted two `let`
// declarations along with the comment above them, and the Drive connect flow
// shipped broken because nothing here noticed.
//
// Deliberately conservative: it only looks at bare `name = value` assignments
// at the start of a line, and treats a name as declared if it appears in any
// declaration, parameter list, destructuring pattern or arrow parameter.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const files = ['server.js', 'electron/main.js']
  .concat(fs.readdirSync(path.join(ROOT, 'utils')).map((f) => `utils/${f}`))
  .concat(fs.readdirSync(path.join(ROOT, 'bots')).map((f) => `bots/${f}`))
  .concat(fs.readdirSync(path.join(ROOT, 'tools')).map((f) => `tools/${f}`))
  .filter((f) => f.endsWith('.js'));

let problems = 0;

for (const file of files) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const assigned = new Set();

  for (const match of source.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*=[^=]/gm)) {
    assigned.add(match[1]);
  }

  for (const name of assigned) {
    const declared = new RegExp(`\\b(?:let|const|var|function|class)\\s+${name}\\b`).test(source)
      || new RegExp(`function[^(]*\\([^)]*\\b${name}\\b`).test(source)
      || new RegExp(`[({,]\\s*${name}\\s*[,})=:]`).test(source)
      || new RegExp(`\\b${name}\\s*=>`).test(source);

    if (!declared) {
      console.error(`${file}: assigns to undeclared '${name}'`);
      problems++;
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} undeclared assignment(s). These throw at runtime, not at parse time.`);
  process.exit(1);
}
