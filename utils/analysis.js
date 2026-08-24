'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Result analysis
//
// Turns one answered question into one spreadsheet row.
//
// COLUMNS (must stay in this exact order — they are pasted into the sheet):
//   Date Checked | Client | Prompt / Query Tested | AI Platform | Search Type |
//   Appeared in Output? | Intent | AI Output Summary | Source Link Cited |
//   Screenshot Link | Notes
//
// "Client" is hidden in the sheet but still needs a column of its own, or every
// value after it lands one column to the left. It carries the client name so a
// pasted block stays attributable on its own.
// ─────────────────────────────────────────────────────────────────────────────

const { MAX_SUMMARY_LENGTH, splitSummary } = require('./summaryPrompt');

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
 * Word-boundary matching stops "Ace" from matching "Facebook" or "placement",
 * which would otherwise mark almost every row as a brand mention. A trailing
 * possessive ("Acme's") still counts.
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
 * Links back to the AI platform itself are dropped — a ChatGPT answer linking
 * to chatgpt.com is navigation, not a citation.
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
 * Matches on the client's own website when one was supplied (most reliable),
 * otherwise falls back to the brand name showing up in the hostname or the
 * link's visible text.
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
 * The four options come from the tracking sheet. "Mentioned" and "No link"
 * both mean the brand was named without being linked, so they are split on
 * whether the answer cited any sources at all:
 *
 *   Not Mentioned   — the brand does not appear in the answer
 *   Cited with link — the brand appears and a cited link points to it
 *   Mentioned       — the brand appears, the answer cites sources, none is the client
 *   No link         — the brand appears and the answer cites nothing at all
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

// Abbreviations that end in a full stop but do not end a sentence. Without
// this, "Dr. Smith recommends Acme" splits after "Dr." and the summary starts
// mid-name.
const ABBREVIATION_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|ave|inc|ltd|co|corp|vs|etc|approx|dept|est|fig|no|al|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m)\.$/i;

/**
 * Strips markdown decoration and list markers from one line of an answer.
 * AI answers are full of "**Heading**", "- item" and "1. item"; none of that
 * belongs in a spreadsheet cell.
 *
 * @param {string} line
 * @returns {string}
 */
function cleanLine(line) {
  return String(line)
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*(?:[-–—•·]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits one line into sentences, keeping abbreviations intact.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitSentences(line) {
  const sentences = [];
  let pending = '';

  for (const chunk of line.split(/(?<=[.!?])\s+/)) {
    pending = pending ? `${pending} ${chunk}` : chunk;

    // Ends on an abbreviation, so the sentence continues into the next chunk.
    if (ABBREVIATION_END.test(pending)) {
      continue;
    }

    sentences.push(pending);
    pending = '';
  }

  if (pending) {
    sentences.push(pending);
  }

  return sentences.filter((sentence) => sentence.trim().length > 0);
}

/**
 * Joins two picked sentences. Real sentences already end in punctuation, so a
 * space is enough; bullet items do not, and running them together turns
 * "Bobs Bread" and "Central Loaf" into one name.
 *
 * @param {string} soFar
 * @returns {string}
 */
function joiner(soFar) {
  return /[.!?…]$/.test(soFar) ? ' ' : '; ';
}

/**
 * FALLBACK summary, used only when the AI ignored the set-up message and never
 * printed an "AI Output Summary:" block of its own (see summaryPrompt.js).
 * Built from the answer text we already captured — no second AI, no API.
 *
 * It is extractive, not written from scratch: it pulls out the sentences that
 * actually name the client, because for this sheet "what did it say about us"
 * is the thing worth reading. When the client is not mentioned at all it falls
 * back to the opening sentences, which tell you what the AI recommended
 * instead — just as useful when you are losing the query.
 *
 * Every word is copied verbatim from the answer and only whole sentences are
 * taken, so the grammar is whatever the AI already wrote. Line breaks are
 * treated as sentence boundaries because bullet points rarely end in a full
 * stop, and running them together produces nonsense like "Acme - sourdough 2.".
 *
 * @param {{ text: string, clientName?: string, maxLength?: number }} input
 * @returns {string}
 */
function summarize({ text, links, clientName, maxLength = MAX_SUMMARY_LENGTH }) {
  const raw = String(text == null ? '' : text).replace(/\[\d+\]/g, '');

  // Sites render their sources as little link chips after the answer. innerText
  // picks each one up as its own line, so without this the summary ends in a
  // run of repeated source names: "The Geronsins; The Geronsins; ...".
  const linkLabels = new Set(
    (Array.isArray(links) ? links : [])
      .map((link) => normalizeText(link && link.label))
      .filter(Boolean)
  );

  const seen = new Set();

  const sentences = raw
    .split(/\r?\n+/)
    .map(cleanLine)
    .filter(Boolean)
    .flatMap(splitSentences)
    .filter((sentence) => {
      const key = normalizeText(sentence);

      // A repeated fragment is a chip or a stray heading, never prose.
      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);

      // Matches a link's own text and does not read as a sentence — a chip.
      return !(linkLabels.has(key) && !/[.!?…]$/.test(sentence.trim()));
    });

  if (sentences.length === 0) {
    return '';
  }

  const aboutClient = clientName
    ? sentences.filter((sentence) => mentions(sentence, clientName))
    : [];
  const chosen = aboutClient.length > 0 ? aboutClient : sentences;

  let summary = '';

  for (const sentence of chosen) {
    if (!summary) {
      summary = sentence;
    } else if (`${summary}${joiner(summary)}${sentence}`.length <= maxLength) {
      summary += `${joiner(summary)}${sentence}`;
    } else {
      break;
    }
  }

  // A single sentence can still run past the limit — cut on a word boundary.
  if (summary.length > maxLength) {
    summary = `${summary.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}…`;
  }

  return summary;
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
 * Everything knowable before the AI answers is filled in immediately — date,
 * prompt, platform, and branded/non-branded — so the grid appears complete and
 * the answer columns fill in as replies arrive.
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

  const text = response && response.text ? response.text : '';
  const links = response && response.links ? response.links : [];

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
    'AI Output Summary': summary || summarize({ text: answer, links, clientName }),
    'Source Link Cited': citedSites(links, platformHost).join(', '),
    'Screenshot Link': '',
    Notes: '',
  };
}

module.exports = {
  COLUMNS,
  INTENT,
  SEARCH_TYPE,
  buildPendingRow,
  buildRow,
  citedSites,
  classifyIntent,
  formatDate,
  hostFromHref,
  linksToClient,
  mentions,
  normalizeText,
  summarize,
};
