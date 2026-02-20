# Contributor Guide

## Project Structure
- `src/`: Main TypeScript application code.
- `src/index.ts`: Orchestration entrypoint (`runOnce`, `runDaily`, `--schedule daily`).
- `src/listings.ts`: RSS ingestion, normalization, dedupe, and cursor stop logic.
- `src/details.ts`: Positive-match detail enrichment (external apply URL extraction).
- `src/classifier.ts`: Gemini-based qualification classifier and rate limiting.
- `src/telegram.ts`: Telegram alert delivery.
- `src/config.ts`: Environment loading and validation.
- `src/state.ts`: Persisted state management (`state.json`, schema versioned).
- `src/phase0.ts`: Baseline/safety artifact generation.
- `src/phase8.ts`: Validation harness for migration checks.
- `src/phase9.ts`: Rollout helper (dist backup + monitored runs/report).
- `dist/`: Compiled JavaScript output from `npx tsc` (generated; do not edit directly).

## Build and Test Commands
- `npm run typecheck`: Type-check project.
- `npx tsc`: Compile to `dist/`.
- `node dist/index.js`: Run one pass.
- `node dist/index.js --schedule daily`: Run continuously with 24h interval.
- `npm run phase8`: Run validation harness.
- `npm run phase9`: Run rollout helper and monitoring report generation.

## Style Guidelines
- Use strict TypeScript patterns (`strict: true`) and explicit types for public interfaces.
- Keep modules focused by concern (RSS ingestion, enrichment, classification, messaging, state).
- Match existing logging style and prefer explicit naming.
- Keep secrets in `.env`; never hardcode API keys, tokens, or chat IDs.
- For new features using external libraries/APIs, check Context7 for latest docs before implementation.

## Testing Guidelines
No formal unit-test suite is enforced yet. Minimum validation for changes:
1. `npm run typecheck`
2. `npx tsc`
3. `node dist/index.js` with safe/test credentials or controlled input

For rollout-related changes, also run:
4. `npm run phase8`
5. `npm run phase9` (or `node dist/phase9.js --runs 3 --skip-build` if already compiled)

Include manual verification notes in each PR (commands run, observed behavior, and edge cases checked).

## PR and Commit Guidelines
- Keep PRs small and scoped to one feature/fix.
- Use Conventional Commit style where possible (`feat:`, `fix:`, `docs:`, `chore:`).
- Update this file when new repo-specific patterns or gotchas are discovered.
- Do not commit `.env`, credentials, or local scratch artifacts.
- Default GitHub username for repository remotes is `parrottizing` unless explicitly overridden.
