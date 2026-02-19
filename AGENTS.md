# Contributor Guide

## Project Structure
- `src/`: Main TypeScript application code.
- `src/index.ts`: Orchestration entrypoint (`runOnce`, `runDaily`, `--schedule daily`).
- `src/listings.ts`: MoAIJobs listing crawl and pagination handling.
- `src/details.ts`: Headless-browser extraction of job details.
- `src/classifier.ts`: Gemini-based qualification classifier and rate limiting.
- `src/telegram.ts`: Telegram alert delivery.
- `src/config.ts`: Environment loading and validation.
- `src/state.ts`: Persisted state management (`state.json`).
- `dist/`: Compiled JavaScript output from `npx tsc` (generated; do not edit directly).

## Build and Test Commands
- `npm run typecheck`: Type-check project.
- `npx tsc`: Compile to `dist/`.
- `node dist/index.js`: Run one pass.
- `node dist/index.js --schedule daily`: Run continuously with 24h interval.

## Style Guidelines
- Use strict TypeScript patterns (`strict: true`) and explicit types for public interfaces.
- Keep modules focused by concern (scraping, extraction, classification, messaging, state).
- Match existing logging style and prefer explicit naming.
- Keep secrets in `.env`; never hardcode API keys, tokens, or chat IDs.
- For new features using external libraries/APIs, check Context7 for latest docs before implementation.

## Testing Guidelines
No formal unit-test suite is enforced yet. Minimum validation for changes:
1. `npm run typecheck`
2. `npx tsc`
3. `node dist/index.js` with safe/test credentials or controlled input

Include manual verification notes in each PR (commands run, observed behavior, and edge cases checked).

## PR and Commit Guidelines
- Keep PRs small and scoped to one feature/fix.
- Use Conventional Commit style where possible (`feat:`, `fix:`, `docs:`, `chore:`).
- Update this file when new repo-specific patterns or gotchas are discovered.
- Do not commit `.env`, credentials, or local scratch artifacts.
- Default GitHub username for repository remotes is `parrottizing` unless explicitly overridden.
