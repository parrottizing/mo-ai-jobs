# RSS-First Architecture Migration Plan

Generated: 2026-02-19

## Objective
- [ ] Replace full website crawling + always-headless extraction with an RSS-first pipeline that enriches only matched jobs.
- [ ] Preserve alert quality while reducing runtime, fragility, and unnecessary network/browser work.

## Phase 0: Baseline and Safety
- [x] Create a working branch for the migration (`codex/rss-first-architecture`).
- [x] Record baseline metrics from the current pipeline (new jobs count, matches count, runtime, Telegram sent count) in `migration/phase0/baseline-metrics.json`.
- [x] Backup `state.json` and document the current state schema in `migration/phase0/state-backups/` and `migration/phase0/state-schema-v0.md`.

## Phase 1: Config and Data Contracts
- [x] Add `RSS_FEED_URL` config with default `https://www.moaijobs.com/ai-jobs.rss`.
- [x] Define feed-level model types (for example: `FeedJob` with `id`, `title`, `detailUrl`, `pubDate`, `company`, `location`, `tags`, `descriptionHtml`, `descriptionText`).
- [x] Define enriched model types (for example: `applyUrl`, `detailFetchStatus`, `enrichmentError`).
- [x] Add explicit limits in config (max items per run, description char cap for classifier input).

## Phase 2: State Schema Upgrade
- [x] Introduce `schemaVersion` in persisted state.
- [x] Add `latestSeenPubDate` cursor field.
- [x] Add bounded dedupe collections (`seenIds`, `notifiedIds`).
- [x] Implement migration logic from existing state shape to the new schema.
- [x] Keep backward compatibility so existing installs do not break.

## Phase 3: RSS Ingestion and Normalization
- [x] Implement RSS reader in `src/listings.ts` that consumes feed items newest-first.
- [x] Parse items with a tolerant approach to malformed namespace tags.
- [x] Normalize and clean description HTML to plain text for classification.
- [x] Use `guid` as primary job ID, fallback to link slug.
- [x] Apply stop conditions using `latestSeenPubDate` and `seenIds`.
- [x] Deduplicate items within the same run.

## Phase 4: Classification Pipeline (RSS Data First)
- [x] Build classifier input from RSS fields only (`title`, `company`, `location`, `tags`, cleaned description).
- [x] Truncate/clip long descriptions before LLM calls to control token usage.
- [x] Classify only truly new jobs after dedupe.
- [x] Persist per-job decision metadata needed for retry/idempotency.

## Phase 5: Detail Enrichment for Positive Matches Only
- [x] Fetch MoAIJobs detail page only when classifier result is `YES`.
- [x] Extract external apply URL from `Apply Now` button anchor.
- [x] Add fallback extraction from page JSON-LD (`JobPosting`) when anchor parsing fails.
- [x] If enrichment fails, keep MoAIJobs detail URL as safe fallback for alerting.
- [x] Keep headless extraction as optional fallback path behind a config flag.

## Phase 6: Telegram Message Upgrade
- [ ] Update message format to include both `Details` (MoAIJobs URL) and `Apply` (external URL when available).
- [ ] Include key context fields (title, company, location, short rationale).
- [ ] Ensure idempotent send behavior using `notifiedIds`.
- [ ] Preserve failure handling and retry behavior for Telegram API calls.

## Phase 7: Reliability and Observability
- [ ] Add retry/backoff for RSS fetch failures.
- [ ] Do not advance state cursor on failed runs.
- [ ] Add run summary logging with counters:
- [ ] `feed_items_total`
- [ ] `new_items_total`
- [ ] `classified_yes_total`
- [ ] `enrichment_failures_total`
- [ ] `telegram_sent_total`
- [ ] `telegram_failed_total`

## Phase 8: Validation and Verification
- [ ] Run `npm run typecheck`.
- [ ] Run `npx tsc`.
- [ ] Run `node dist/index.js` with safe/test credentials.
- [ ] Verify no duplicate alerts across repeated runs with unchanged feed.
- [ ] Verify matched jobs include external apply links when available.
- [ ] Verify unmatched jobs do not trigger detail-page fetches.
- [ ] Compare runtime and request count against baseline.

## Phase 9: Rollout
- [ ] Deploy changes with backup of previous build artifacts.
- [ ] Monitor first 3 scheduled runs for duplicate alerts and enrichment failures.
- [ ] If stable, remove dead code paths from legacy full-site listing crawl.
- [ ] Update `README.md` and `AGENTS.md` notes for new architecture behavior.

## Done Criteria
- [ ] New jobs are discovered from RSS only.
- [ ] Positive matches include reliable apply links (external preferred, detail fallback).
- [ ] Duplicate alerts are prevented across retries and reruns.
- [ ] Runtime and operational complexity are lower than the old flow.
