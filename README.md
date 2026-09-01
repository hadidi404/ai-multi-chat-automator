# AI Multi-Chat

Sends a list of questions to ChatGPT, Gemini, Perplexity, Grok and Meta AI in
one pass, then builds a results grid ready to paste into a tracking sheet.

Built for brand visibility tracking: for each question and each AI, it records
whether the client was mentioned, how they were cited, and a summary of the
answer.

## How it works

The app drives a real browser signed in to your own accounts — no API keys.
Each AI gets its own tab, all of them running in parallel. Answers are read
back off the page and turned into one spreadsheet row per question per site.

Each conversation is primed once with an instruction to end every answer with a
short labelled summary, so the summary comes from the AI rather than from
keyword matching here.

## Requirements

- Windows 10 or later
- Google Chrome (Brave is used as a fallback)

## Install

Download the latest `AI Multi-Chat Setup <version>.exe` from the
[releases page](../../releases) and run it. Windows SmartScreen will warn about
an unrecognised app: choose **More info → Run anyway**.

The app checks for a newer version on launch and installs it before starting.

## Usage

1. **Sign in** — opens Google and all five AI sites in one window. Sign in to
   each, then close it. Logins are saved for future runs.
2. **Set the client** — the name and website the answers are checked against.
3. **Enter questions** — one per line.
4. **Pick the AIs** and start the run.
5. **Fill in screenshots** — rows where the client appeared get a *Jump to
   question* button that brings the browser to that exact answer. Paste the
   screenshot, or a Drive link, into the row.
6. **Copy the grid** into your sheet.

Screenshots can upload to a Google Drive folder automatically; set that up once
in the Screenshot links panel.

## Columns

| Column | Source |
| --- | --- |
| Date Checked | Run date, in the sheet's timezone |
| Client | The client name entered for the run |
| Prompt / Query Tested | The question as sent |
| AI Platform | Which site answered |
| Search Type | Branded when the question names the client |
| Appeared in Output? | Whether the answer mentions the client |
| Intent | How the client was cited, if at all |
| AI Output Summary | Written by the AI; blank if it did not provide one |
| Source Link Cited | Distinct domains cited in the answer |
| Screenshot Link | Filled in by you, or by the Drive upload |
| Notes | Why a row could not be filled in |

## Development

```bash
npm install
npm run web      # server only, opens in your default browser
npm start        # desktop shell
npm run check    # syntax check
npm run dist     # build the Windows installer into dist/
```

Publishing a release requires a GitHub token with `repo` scope:

```bash
npm version patch
GH_TOKEN=<token> npm run release
```

That uploads a draft release. Installed copies update once it is published.

## Troubleshooting

**A bot stops reading answers.** The site changed its markup. Run
`node tools/inspect.js <bot> "<a question>"` to see what each selector matches,
then update the selectors in `bots/<bot>.js`.

**Every site shows as logged out.** The browser profile was created by a
different browser. Cookies are encrypted per-browser, so they cannot be shared;
sign in again, or delete the profile folder and start over.

**A run will not start.** Close any window using the automation profile,
including the sign-in window.
