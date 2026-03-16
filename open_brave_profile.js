'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { resolveBravePath } = require('./utils/resolveBravePath');

const USER_DATA_DIR = path.join(__dirname, 'user-data');

function main() {
  const braveExecutablePath = resolveBravePath();

  if (!braveExecutablePath) {
    console.error('Brave executable not found.');
    console.error('Set BRAVE_PATH to your Brave executable location and try again.');
    process.exit(1);
  }

  const args = [
    `--user-data-dir=${USER_DATA_DIR}`,
    '--start-maximized',
    'https://accounts.google.com/',
  ];

  const child = spawn(braveExecutablePath, args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  console.log('Opened Brave with the shared automation profile.');
  console.log('Log in to Google, then close Brave normally to save the session.');
}

main();
