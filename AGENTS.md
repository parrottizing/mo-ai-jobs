# Contributor Guide

## Project Structure
- `src/`: Main TypeScript application code.
- `src/index.ts`: Agent orchestration entrypoint (`runOnce`, `--schedule daily`).
- `src/listings.ts`, `src/details.ts`: MoAIJobs listing scrape and job-detail extraction (headless browser).
- `src/classifier.ts`: Gemini match classification.
- `src/telegram.ts`: Telegram alert delivery.
- `src/config.ts`, `src/state.ts`: Environment loading and persisted state management.
- `dist/`: Compiled JavaScript output from `npx tsc` (generated; do not edit directly).
- `flowchart/`: React + Vite visualization of the Ralph loop.
- `tasks/`, `prd.json`, `progress.txt`: PRD and iteration-tracking artifacts.

## Build and Test Commands
- `npm run typecheck`: Type-check root TypeScript project.
- `npx tsc`: Compile root project to `dist/`.
- `node dist/index.js`: Run one agent pass.
- `node dist/index.js --schedule daily`: Run continuously on a 24-hour cadence.
- `cd flowchart && npm run dev`: Run flowchart dev server.
- `cd flowchart && npm run build`: Build flowchart.
- `cd flowchart && npm run lint`: Lint flowchart code.

## Style Guidelines
- Follow strict TypeScript patterns (`strict: true`) and keep explicit types on public interfaces.
- Keep modules focused by concern (scraping, classification, messaging, state).
- Match existing formatting and logging style; prefer clear naming over clever abstractions.
- Keep secrets in `.env`; never hardcode tokens or chat IDs.
- For new features using external libraries/APIs, check Context7 for current docs before implementation.

## Testing Guidelines
No formal unit-test suite is enforced yet. Minimum validation for changes:
1. `npm run typecheck`
2. `npx tsc`
3. `node dist/index.js` with safe/test credentials or controlled input
4. If `flowchart/` changed: `cd flowchart && npm run lint && npm run build`

Include manual verification notes in each PR (commands run, observed behavior, and edge cases checked).

## PR and Commit Guidelines
- Keep PRs small and scoped to one feature/fix.
- Use Conventional Commit style where possible (`feat:`, `fix:`, `docs:`, `chore:`).
- Reference relevant PRD story IDs when applicable.
- Update this file when new repo-specific patterns or gotchas are discovered.
- Do not commit `.env`, credentials, or local scratch artifacts.
- Default GitHub username for repository remotes is `parrottizing` unless explicitly overridden.
