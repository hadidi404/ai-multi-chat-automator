'use strict';

// Turns one answered question into one spreadsheet row.
//
// Column order matters: the row is pasted straight into the tracking sheet.

const { splitSummary } = require('./summaryPrompt');

const COLUMNS = [
  'Date Checked',
  'Client',
  'Prompt / Query Tested',
  'AI Platform',
  'Search Type',
  'Appeared in Output?',
  'Intent',
  'AI Output Summary',
  'Source Link Cited',
  'Screenshot Link',
  'Notes',
];

const SEARCH_TYPE = {
  BRANDED: 'Branded',
  NON_BRANDED: 'Non-Branded',
};

const INTENT = {
  CITED_WITH_LINK: 'Cited with link',
  MENTIONED: 'Mentioned',
  NO_LINK: 'No link',
  NOT_MENTIONED: 'Not Mentioned',
};

/**
 * Lowercases, straightens curly apostrophes, and collapses whitespace so that
 * "Acme’s  Bakery" and "acme's bakery" compare equal.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `needle` appears in `haystack` as a whole word.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
function mentions(haystack, needle) {
  const text = normalizeText(haystack);
  const name = normalizeText(needle);

  if (!text || !name) {
    return false;
  }

  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}('s)?([^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

/**
 * Extracts a clean hostname ("example.com") from a URL.
 * Returns '' for anchors, javascript: links, and anything unparseable.
 *
 * @param {string} href
 * @returns {string}
 */
function hostFromHref(href) {
  try {
    const parsed = new URL(String(href));

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The distinct websites cited in an answer, in the order they appeared.
 *
 * @param {{ href: string }[]} links
 * @param {string} [platformHost]
 * @returns {string[]}
 */
function citedSites(links, platformHost) {
  const ignored = new Set(
    [platformHost, 'google.com', 'accounts.google.com', 'gstatic.com']
      .filter(Boolean)
      .map((host) => String(host).replace(/^www\./i, '').toLowerCase())
  );

  const seen = [];

  for (const link of Array.isArray(links) ? links : []) {
    const host = hostFromHref(link && link.href);

    if (!host || ignored.has(host) || seen.includes(host)) {
      continue;
    }

    seen.push(host);
  }

  return seen;
}

/**
 * True when one of the cited links points at the client.
 *
 * @param {{ href: string, label: string }[]} links
 * @param {string} clientName
 * @param {string} [clientSite]
 * @returns {boolean}
 */
function linksToClient(links, clientName, clientSite) {
  const clientHost = clientSite ? hostFromHref(clientSite) || normalizeText(clientSite) : '';

  for (const link of Array.isArray(links) ? links : []) {
    const host = hostFromHref(link && link.href);

    if (!host) {
      continue;
    }

    if (clientHost && (host === clientHost || host.endsWith(`.${clientHost}`))) {
      return true;
    }

    // No client website given — fall back to the brand name itself.
    if (!clientHost && clientName) {
      const compactName = normalizeText(clientName).replace(/[^a-z0-9]/g, '');

      if (compactName && host.replace(/[^a-z0-9]/g, '').includes(compactName)) {
        return true;
      }

      if (mentions(link.label, clientName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Classifies how the client showed up in an answer.
 *
 * @param {{ text: string, links: object[], clientName: string, clientSite?: string }} input
 * @returns {string}
 */
function classifyIntent({ text, links, clientName, clientSite }) {
  if (!mentions(text, clientName)) {
    return INTENT.NOT_MENTIONED;
  }

  if (linksToClient(links, clientName, clientSite)) {
    return INTENT.CITED_WITH_LINK;
  }

  const hasAnyCitation = citedSites(links).length > 0;
  return hasAnyCitation ? INTENT.MENTIONED : INTENT.NO_LINK;
}

// The sheet is read in New York, so a check run from another timezone must
// still be dated by the New York calendar — otherwise a late-evening run there
// (or a morning run in Asia) lands on the wrong day. Naming the zone rather
// than a fixed -5 offset keeps EST/EDT switching automatic.
const SHEET_TIME_ZONE = 'America/New_York';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHEET_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/**
 * The date in New York as M/D/YYYY (e.g. 8/21/2026) — the format the tracking
 * sheet uses. No leading zeros, matching how Google Sheets renders a US date.
 *
 * @param {Date} [date]
 * @returns {string}
 */
function formatDate(date = new Date()) {
  return DATE_FORMATTER.format(date);
}

/**
 * Removes the question when a site's answer blocks include it.
 *
 * @param {string} text
 * @param {string} question
 * @returns {string}
 */
function stripEchoedQuestion(text, question) {
  const wanted = normalizeText(question);
  const raw = String(text == null ? '' : text);

  if (!wanted) {
    return raw;
  }

  const lines = raw.split(/\r?\n/);
  let taken = 0;
  let accumulated = '';

  for (const line of lines) {
    const next = normalizeText(`${accumulated} ${line}`);

    if (!next) {
      taken++;
      continue;
    }

    if (!wanted.startsWith(next)) {
      break;
    }

    accumulated = next;
    taken++;

    if (next === wanted) {
      break;
    }
  }

  if (accumulated !== wanted) {
    return raw;
  }

  return lines.slice(taken).join('\n').trim();
}

/**
 * Branded when the client's name is in the question itself.
 * Blank when no client name was given — see buildRow for why.
 *
 * @param {string} question
 * @param {string} clientName
 * @returns {string}
 */
function searchTypeFor(question, clientName) {
  if (!clientName) {
    return '';
  }

  return mentions(question, clientName) ? SEARCH_TYPE.BRANDED : SEARCH_TYPE.NON_BRANDED;
}

/**
 * An empty row, created the moment a run starts.
 *
 * @param {{ question: string, platform: string, clientName: string, askedAt?: Date }} input
 * @returns {object}
 */
function buildPendingRow({ question, platform, clientName, askedAt }) {
  return {
    'Date Checked': formatDate(askedAt),
    Client: clientName || '',
    'Prompt / Query Tested': question,
    'AI Platform': platform,
    'Search Type': searchTypeFor(question, clientName),
    'Appeared in Output?': '',
    Intent: '',
    'AI Output Summary': '',
    'Source Link Cited': '',
    'Screenshot Link': '',
    Notes: '',
  };
}

/**
 * Builds one spreadsheet row from one answered question.
 *
 * @param {{
 *   question: string,
 *   platform: string,
 *   platformHost?: string,
 *   clientName: string,
 *   clientSite?: string,
 *   response?: { text: string, links: object[] } | null,
 *   readFailed?: boolean,
 *   askedAt?: Date,
 * }} input
 * @returns {object}
 */
function buildRow(input) {
  const {
    question,
    platform,
    platformHost,
    clientName,
    clientSite,
    response,
    readFailed,
    askedAt,
  } = input;

  const rawText = response && response.text ? response.text : '';
  const links = response && response.links ? response.links : [];

  // Anything the site echoed back of our own question is not part of the answer.
  const text = stripEchoedQuestion(rawText, question);

  // Every judgement column is relative to a client name. Without one, leaving
  // them blank is honest; filling them in would read as "brand never appeared".
  const searchType = searchTypeFor(question, clientName);

  // When the answer could not be read, guessing "No" would put wrong data in a
  // client-facing sheet. Leave the judgement columns blank and say why —
  // naming the actual cause, because "check this manually" on its own does not
  // tell you whether the site changed its markup or the run hit an error.
  if (readFailed || !text) {
    const reason = response && response.reason ? String(response.reason).trim() : '';

    return {
      'Date Checked': formatDate(askedAt),
      Client: clientName || '',
      'Prompt / Query Tested': question,
      'AI Platform': platform,
      'Search Type': searchType,
      'Appeared in Output?': '',
      Intent: '',
      'AI Output Summary': '',
      'Source Link Cited': '',
      'Screenshot Link': '',
      Notes: reason
        ? `Could not read the AI answer (${reason}) — check this one manually.`
        : 'Could not read the AI answer — check this one manually.',
    };
  }

  // The AI was asked to end its reply with a summary block. Everything else is
  // judged on the answer WITHOUT it: the summary names the client because we
  // told it to, so leaving it in would mark "Appeared in Output?" as Yes for an
  // answer that never actually mentioned them.
  const { body, summary } = splitSummary(text);
  const answer = body || text;

  const appeared = clientName ? mentions(answer, clientName) : null;

  return {
    'Date Checked': formatDate(askedAt),
    Client: clientName || '',
    'Prompt / Query Tested': question,
    'AI Platform': platform,
    'Search Type': searchType,
    'Appeared in Output?': appeared === null ? '' : (appeared ? 'Yes' : 'No'),
    Intent: clientName ? classifyIntent({ text: answer, links, clientName, clientSite }) : '',
    // Left blank on purpose when the AI did not write one. A guessed summary
    // stitched together from the answer's own sentences looks like a real
    // result, so a run where the set-up message was missed would be pasted into
    // the sheet unnoticed. An empty cell in a full column is the signal to
    // rerun it or write it by hand.
    'AI Output Summary': summary,
    'Source Link Cited': citedSites(links, platformHost).join(', '),
    'Screenshot Link': '',
    Notes: '',
  };
}

module.exports = {
  COLUMNS,
  buildPendingRow,
  buildRow,
};
