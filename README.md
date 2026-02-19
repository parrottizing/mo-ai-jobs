# MO AI Jobs Agent

Daily TypeScript agent that scans MoAIJobs for new listings, classifies each role against an AI-native candidate profile using Gemini, and sends Telegram alerts for matches.

## What It Does

1. Loads config from `.env`
2. Reads `state.json` to get the last seen job
3. Crawls MoAIJobs listings and collects only new jobs
4. Opens each job in a headless browser and extracts structured details
5. Classifies fit with Gemini (`gemma-3-27b-it` by default)
6. Sends Telegram alerts for matching jobs only
7. Updates `state.json` after successful processing

## Project Structure

- `src/index.ts`: Main orchestration (`runOnce`, `runDaily`)
- `src/config.ts`: Environment config loading and validation
- `src/state.ts`: Local state persistence (`lastSeenJobId`)
- `src/listings.ts`: Listings crawl and pagination logic
- `src/details.ts`: Headless-browser job detail extraction
- `src/classifier.ts`: Gemini classification, rate-limit handling, retries
- `src/telegram.ts`: Telegram alert delivery
- `dist/`: Compiled JavaScript output

## Prerequisites

- Node.js 20+
- A Chrome/Chromium binary available locally (or set one of: `CHROME_PATH`, `CHROMIUM_PATH`, `GOOGLE_CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH`)
- Google Gemini API key
- Telegram bot token and chat ID

## Environment

Create `.env` in the project root:

```bash
GOOGLE_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
LISTINGS_URL=https://www.moaijobs.com/
GEMINI_TOKENS_PER_MINUTE=15000
GEMINI_TOKEN_SAFETY_MARGIN=0.6
GEMINI_MIN_DELAY_MS=0
```

## Install

```bash
npm install
```

## Build and Run

Typecheck:

```bash
npm run typecheck
```

Compile:

```bash
npx tsc
```

Run once:

```bash
node dist/index.js
```

Run every 24 hours:

```bash
node dist/index.js --schedule daily
```

Phase 0 migration baseline (after `npx tsc`):

```bash
npm run phase0
```

Optional flags for `dist/phase0.js`:

- `--state-file <path>` (default: `state.json`)
- `--metrics-path <path>` (default: `migration/phase0/baseline-metrics.json`)
- `--backup-dir <path>` (default: `migration/phase0/state-backups`)
- `--schema-path <path>` (default: `migration/phase0/state-schema-v0.md`)

## Output Files

- `state.json`: stores `lastSeenJobId`
- `migration/phase0/baseline-metrics.json`: baseline run summary (new jobs, matches, runtime, Telegram sent count)
- `migration/phase0/state-backups/`: timestamped `state.json` backups captured before baseline run
- `migration/phase0/state-schema-v0.md`: documented pre-migration state schema

## Notes

- Classification is deterministic-oriented and expects model output beginning with `YES` or `NO`.
- Telegram failures are logged per message and do not stop the full run.
