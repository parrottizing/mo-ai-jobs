# PRD: Vibe Coder Job Agent

## Introduction

Create an AI agent that checks https://www.moaijobs.com daily for new job postings and notifies the user on Telegram only when a posting matches the “vibe coder” role. The agent must remember which jobs were already processed, scan all new listings (including pagination), open each new vacancy, analyze its description with an LLM classifier, and send a Telegram message for matches only.

## Goals

- Detect and process only new job postings since the last run
- Analyze each new job description with an LLM to determine “vibe coder” fit
- Send a Telegram message for each matching job, and no message for non-matches
- Run automatically once per day without manual intervention

## User Stories

### US-001: Persist last-seen job state
**Description:** As a user, I want the agent to remember which jobs were already processed so it only checks new ones.

**Acceptance Criteria:**
- [ ] Store a local JSON state file containing the last-seen job identifier(s)
- [ ] On startup, load state file or initialize if missing
- [ ] After a successful run, update the state file with the newest processed job
- [ ] Typecheck/lint passes (if applicable)

### US-002: Discover new jobs with pagination
**Description:** As a user, I want the agent to find all new jobs since the last run, even if they span multiple pages.

**Acceptance Criteria:**
- [ ] Fetch the main job list page and parse job items in order
- [ ] If the last-seen job is not found on the first page, continue to next pages until found or end of listings
- [ ] Collect all jobs published after the last-seen job as “new”
- [ ] Handle the case where the last-seen job no longer exists (treat all current jobs as new)
- [ ] Typecheck/lint passes (if applicable)

### US-003: Open and analyze each new job
**Description:** As a user, I want the agent to open each new vacancy and decide if it matches “vibe coder” using an LLM.

**Acceptance Criteria:**
- [ ] Open each new job detail page with a headless browser
- [ ] Extract title, company, location, tags, and full description text
- [ ] Send extracted data to an LLM classifier with a deterministic prompt
- [ ] Classifier returns a boolean match plus a short rationale
- [ ] Typecheck/lint passes (if applicable)

### US-004: Notify via Telegram for matches only
**Description:** As a user, I want to receive a Telegram message only when a job matches.

**Acceptance Criteria:**
- [ ] For each matching job, send one Telegram message with title, company, and link
- [ ] Do not send any message for non-matching jobs
- [ ] If Telegram API call fails, log the error and continue
- [ ] Typecheck/lint passes (if applicable)

### US-005: Daily scheduled execution
**Description:** As a user, I want the agent to run once per day automatically.

**Acceptance Criteria:**
- [ ] Provide a scheduled execution method (cron, OS scheduler, or built-in scheduler)
- [ ] The run completes without user interaction
- [ ] Log run start/end, number of new jobs processed, and number of matches
- [ ] Typecheck/lint passes (if applicable)

## Functional Requirements

- FR-1: The system must store last-seen job state in a local JSON file.
- FR-2: The system must open https://www.moaijobs.com and parse the job listing items in display order.
- FR-3: The system must follow pagination until it finds the last-seen job or reaches the end.
- FR-4: The system must open each new job detail page with a headless browser.
- FR-5: The system must extract job title, company, location, tags, and description text.
- FR-6: The system must classify each job via LLM and return match true/false with a short rationale.
- FR-7: The system must send Telegram alerts only for matches.
- FR-8: The system must log errors but continue processing remaining jobs.
- FR-9: The system must run once per day via a scheduler.

## Non-Goals (Out of Scope)

- Building a UI or dashboard
- Sending notifications by email or other channels
- Applying to jobs or auto-filling applications
- Real-time monitoring more frequent than once per day
- Storing job data in a remote database

## Design Considerations (Optional)

- Message format should be concise and include job title, company, and a direct link
- Provide a config file or env vars for Telegram bot token and chat ID
- Provide a “dry run” flag that processes jobs without sending notifications
- Use a `.env` file for secrets: `GOOGLE_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

## Technical Considerations (Optional)

- Headless browser recommended: Playwright or Puppeteer
- Use a stable job identifier (job URL or slug) for last-seen tracking
- LLM provider: Google Gemini API (Google AI Studio API key)
- Model: `gemma-3-27b-it` (Gemma 3 27B instruction-tuned) via Gemini API
- LLM prompt should be deterministic and anchored to “vibe coder” criteria
- Handle anti-bot measures (timeouts, retries, user-agent)
- Respect robots.txt and site terms where applicable

## Success Metrics

- 100% of new jobs since last run are processed
- 0 false-positive Telegram notifications in a 2-week period
- Average daily run completes in under 5 minutes

## Open Questions

- Should matches include a short rationale in the Telegram message?
- Should the agent keep a separate history of matched jobs beyond the last-seen state?
