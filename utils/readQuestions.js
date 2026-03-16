'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Reads questions from questions.txt (one per line) and returns
 * them as an array of trimmed, non-empty strings.
 *
 * The file is expected to live in the project root directory
 * (one level above the utils/ folder).
 *
 * @returns {string[]} Array of question strings
 */
function readQuestions() {
  // Resolve the path relative to the project root
  const filePath = path.join(__dirname, '..', 'questions.txt');

  if (!fs.existsSync(filePath)) {
    console.error(`[readQuestions] questions.txt not found at: ${filePath}`);
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf-8');

  // Split by newline, trim whitespace, and filter blank lines
  const questions = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (questions.length === 0) {
    console.warn('[readQuestions] questions.txt is empty.');
  }

  return questions;
}

module.exports = { readQuestions };
