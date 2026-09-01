'use strict';

// Each conversation is primed once, before any question, to end every answer
// with a labelled summary block. buildRow lifts that block out of the reply.

/** The exact label the AIs are told to print, and what the parser looks for. */
const SUMMARY_LABEL = 'AI Output Summary';

// A backstop, not a target. The AI is already asked for 1-2 sentences, so this
// only catches a model that ignored that and wrote an essay — without it, one
// bad reply drops a wall of text into a spreadsheet cell.
const MAX_SUMMARY_LENGTH = 600;

// {client} is swapped for the client name just before sending, so one fixed
// wording keeps working whoever the run is tracking.
const CLIENT_TOKEN = /\{client\}/gi;

/**
 * The brief every AI is held to. Deliberately fixed rather than editable: the
 * column is only comparable across platforms and across weeks if every row was
 * written to the same instruction, and the one thing that genuinely changes
 * between runs — the client — is already known from the run itself.
 */
const SUMMARY_RULES = [
  'If {client} is mentioned anywhere in your answer, summarise what you said about {client} specifically — how they came up and how they were described.',
  'If {client} is not mentioned in your answer, summarise the answer in general and name whichever option you ranked highest.',
];

/**
 * Fills {client} in. With no client name the rules still have to read as
 * instructions, so they fall back to a description rather than an empty gap.
 *
 * @param {string} rule
 * @param {string} clientName
 * @returns {string}
 */
function applyClient(rule, clientName) {
  const name = String(clientName || '').trim();
  return String(rule).replace(CLIENT_TOKEN, name || 'the brand being tracked');
}

/**
 * The set-up message sent to every AI once, before any question.
 *
 * @param {{ clientName?: string }} input
 * @returns {string}
 */
function buildPrimer({ clientName } = {}) {
  return [
    'Set-up message — this is not a question, so do not answer it. Reply with just: Ready',
    '',
    'For every question I send after this one, answer it normally and in full, then end your reply with this block on its own line:',
    '',
    `${SUMMARY_LABEL}: <1-2 sentences>`,
    '',
    'Rules for that summary:',
    ...SUMMARY_RULES.map((rule) => `- ${applyClient(rule, clientName)}`),
    '',
    `Keep it to 1-2 sentences of plain text with no bullet points, and print the "${SUMMARY_LABEL}:" label exactly that way every single time — including on short answers.`,
  ].join('\n');
}

/**
 * Trims an over-long summary back to whole sentences.
 *
 * @param {string} summary
 * @param {number} maxLength
 * @returns {string}
 */
function trimToSentences(summary, maxLength) {
  if (summary.length <= maxLength) {
    return summary;
  }

  const sentences = summary.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [];
  let kept = '';

  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence.trim()}` : sentence.trim();

    if (next.length > maxLength) {
      break;
    }

    kept = next;
  }

  // One sentence longer than the whole budget: there is no boundary to cut on,
  // so fall back to a word boundary and mark it as cut.
  return kept || `${summary.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}…`;
}

// The label as the AIs actually print it: sometimes bolded, sometimes as a
// heading, sometimes followed by an em dash instead of a colon.
const SUMMARY_HEADING = new RegExp(
  `^[\\s>*_\`#-]*${SUMMARY_LABEL}\\s*[:：\\-–—]?\\s*(.*)$`,
  'i'
);

/**
 * Strips the markdown an AI wraps around a sentence and collapses whitespace.
 *
 * @param {string} value
 * @returns {string}
 */
function tidy(value) {
  return String(value == null ? '' : value)
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits an answer into the answer proper and the summary block we asked for.
 *
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {{ body: string, summary: string }}
 */
function splitSummary(text, maxLength = MAX_SUMMARY_LENGTH) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split(/\r?\n/);

  let markerIndex = -1;
  let firstLineRest = '';

  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(SUMMARY_HEADING);

    if (match) {
      markerIndex = index;
      firstLineRest = match[1] || '';
      break;
    }
  }

  if (markerIndex === -1) {
    return { body: raw, summary: '' };
  }

  // Usually the sentences sit on the label's own line; a model that made the
  // label a heading puts them on the lines below it instead.
  const collected = [tidy(firstLineRest)];

  if (!collected[0]) {
    for (let index = markerIndex + 1; index < lines.length; index++) {
      const line = tidy(lines[index]);

      if (!line) {
        if (collected.some(Boolean)) {
          break;
        }

        continue;
      }

      collected.push(line);
    }
  }

  const summary = trimToSentences(collected.filter(Boolean).join(' ').trim(), maxLength);

  return {
    body: lines.slice(0, markerIndex).join('\n').trim(),
    summary,
  };
}

module.exports = {
  buildPrimer,
  splitSummary,
};
