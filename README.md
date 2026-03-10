# MO AI Jobs Agent

RSS-first TypeScript agent that reads new MoAIJobs entries from the feed, classifies fit with Gemini, enriches only positive matches, and sends Telegram alerts.

## What It Does

1. Loads configuration from `.env`.
2. Reads persisted state (`schemaVersion`, `latestSeenPubDate`, `seenIds`, `notifiedIds`).
3. Fetches and parses the RSS feed (with retry/backoff).
4. Classifies only new RSS jobs from feed fields (`title`, `company`, `location`, `tags`, `description`).
5. Enriches only `YES` matches by extracting external apply links from the detail page.
6. Sends Telegram alerts with both `Details` and `Apply` links.
7. Persists updated cursor/dedupe/classification state after successful processing.

## Project Structure

- `src/index.ts`: Main orchestration (`runOnce`, `runDaily`, summaries/counters).
- `src/config.ts`: Environment loading and validation.
- `src/state.ts`: State schema normalization and persistence (`schemaVersion: 2`).
- `src/listings.ts`: RSS ingestion, normalization, dedupe, and cursor stop conditions.
- `src/rss-models.ts`: Feed and enrichment data contracts.
- `src/details.ts`: Positive-match detail enrichment (HTTP first, optional headless fallback).
- `src/classifier.ts`: Gemini classification, token/rate control, retries.
- `src/telegram.ts`: Telegram delivery and idempotent send handling.
- `src/phase0.ts`: Baseline/safety artifact generator.
- `src/phase8.ts`: Validation and verification harness.
- `src/phase9.ts`: Rollout helper (build backup + monitored runs report).

## Prerequisites

- Node.js 20+
- Google Gemini API key
- Telegram bot token and chat ID
- Optional Chrome/Chromium binary only if `DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED=true`

## Environment

Create `.env` in the project root:

```bash
GOOGLE_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
RSS_FEED_URL=https://www.moaijobs.com/ai-jobs.rss
RSS_MAX_ITEMS_PER_RUN=100
RSS_MAX_PAGES_PER_RUN=10
RSS_FETCH_MAX_ATTEMPTS=3
RSS_FETCH_INITIAL_BACKOFF_MS=1000
RSS_FETCH_MAX_BACKOFF_MS=15000
CLASSIFIER_DESCRIPTION_CHAR_CAP=4000
GEMINI_REQUESTS_PER_MINUTE=30
GEMINI_TOKENS_PER_MINUTE=15000
GEMINI_TOKEN_SAFETY_MARGIN=1
GEMINI_MIN_DELAY_MS=0
DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED=false
```

For VibeCodeCareers, set:

```bash
RSS_FEED_URL=https://vibecodecareers.com/jobs/feed/
RSS_MAX_PAGES_PER_RUN=10
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

Run once with a custom state file:

```bash
node dist/index.js --state-file state.vibecodecareers.json
```

Run every 24 hours:

```bash
node dist/index.js --schedule daily
```

Run every 24 hours with a custom state file:

```bash
node dist/index.js --schedule daily --state-file state.vibecodecareers.json
```

Phase 0 baseline artifacts:

```bash
npx tsc
npm run phase0
```

Phase 8 verification:

```bash
npx tsc
npm run phase8
```

Phase 9 rollout helper:

```bash
npx tsc
npm run phase9
```

`phase9` will:

1. Back up existing `dist/` artifacts to `migration/phase9/dist-backups/` (if present).
2. Rebuild `dist/` with `npx tsc` (unless `--skip-build` is used).
3. Run the pipeline 3 times (default) and detect duplicate alert IDs, enrichment failures, and Telegram failures.
4. Write a report to `migration/phase9/rollout-report.json`.

Optional flags for `dist/phase0.js`:

- `--state-file <path>` (default: `state.json`)
- `--metrics-path <path>` (default: `migration/phase0/baseline-metrics.json`)
- `--backup-dir <path>` (default: `migration/phase0/state-backups`)
- `--schema-path <path>` (default: `migration/phase0/state-schema-v0.md`)

Optional flags for `dist/phase8.js`:

- `--state-file <path>` (default: `migration/phase8/state.phase8.test.json`)
- `--report-path <path>` (default: `migration/phase8/validation-report.json`)
- `--baseline-metrics-path <path>` (default: `migration/phase0/baseline-metrics.json`)

Optional flags for `dist/phase9.js`:

- `--state-file <path>` (default: `state.json`)
- `--report-path <path>` (default: `migration/phase9/rollout-report.json`)
- `--dist-dir <path>` (default: `dist`)
- `--backup-dir <path>` (default: `migration/phase9/dist-backups`)
- `--runs <count>` (default: `3`)
- `--skip-build`

## Output Files

- `state.json`: runtime state (`schemaVersion`, `latestSeenPubDate`, `seenIds`, `notifiedIds`, `classificationDecisions`).
- `migration/phase0/baseline-metrics.json`: baseline summary metrics.
- `migration/phase0/state-backups/`: timestamped state backups.
- `migration/phase0/state-schema-v0.md`: documented pre-migration schema snapshot.
- `migration/phase8/state.phase8.test.json`: isolated state for Phase 8 harness.
- `migration/phase8/validation-report.json`: Phase 8 check results.
- `migration/phase9/dist-backups/`: backup copies of previous `dist/` artifacts.
- `migration/phase9/rollout-report.json`: Phase 9 rollout monitoring report.

## Notes

- Classification is deterministic-oriented and expects model output beginning with `YES` or `NO`.
- Classifier throttling enforces both request and token budgets per minute.
- Telegram failures are logged per message and do not abort the run.
