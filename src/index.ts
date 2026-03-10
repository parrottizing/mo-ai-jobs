import { loadConfig } from "./config";
import { classifyJobs, type JobMatchResult } from "./classifier";
import { enrichFeedJob } from "./details";
import { collectFeedJobs } from "./listings";
import type { EnrichedFeedJob, FeedJob } from "./rss-models";
import {
  loadState,
  saveState,
  type ClassificationDecisionRecord,
} from "./state";
import {
  sendTelegramAlerts,
  type TelegramAlertResult,
  type TelegramAlertStats,
} from "./telegram";

export * from "./details";
export * from "./listings";
export * from "./rss-models";
export * from "./classifier";
export * from "./telegram";

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RunCounters = {
  feed_items_total: number;
  new_items_total: number;
  classified_yes_total: number;
  enrichment_failures_total: number;
  telegram_sent_total: number;
  telegram_failed_total: number;
};

export type RunSummary = {
  startedAt: string;
  finishedAt: string;
  runtimeMs: number;
  newJobsCount: number;
  matchesCount: number;
  telegramSentCount: number;
  telegramFailedCount: number;
  telegramSkippedCount: number;
  sentJobIds: string[];
  counters: RunCounters;
};

export type RunOnceOptions = {
  stateFilePath?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export async function runOnce(options: RunOnceOptions = {}): Promise<void> {
  await runOnceWithSummary(options);
}

export async function runOnceWithSummary(options: RunOnceOptions = {}): Promise<RunSummary> {
  const config = loadConfig(options.stateFilePath);
  const state = await loadState(config.stateFilePath);
  const startedAt = new Date();
  const counters = createRunCounters();

  log(`Run started (${startedAt.toISOString()})`);

  const feedCollection = await collectFeedJobs({
    rssFeedUrl: config.rssFeedUrl,
    latestSeenPubDate: state.latestSeenPubDate,
    seenIds: state.seenIds,
    maxItemsPerRun: config.maxFeedItemsPerRun,
    rssMaxPagesPerRun: config.rssMaxPagesPerRun,
    rssFetchMaxAttempts: config.rssFetchMaxAttempts,
    rssFetchInitialBackoffMs: config.rssFetchInitialBackoffMs,
    rssFetchMaxBackoffMs: config.rssFetchMaxBackoffMs,
    onRssRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      log(
        `RSS fetch attempt ${attempt}/${maxAttempts} failed: ${error}. Retrying in ${delayMs}ms.`,
      );
    },
    fetcher: options.fetcher,
  });
  counters.feed_items_total = feedCollection.feedItemsTotal;

  const newFeedJobs = feedCollection.newFeedJobs;
  const newJobs = dedupeFeedJobsById(newFeedJobs);
  counters.new_items_total = newJobs.length;

  log(`New jobs found: ${newJobs.length}`);

  if (newJobs.length === 0) {
    const alertStats: TelegramAlertStats = {
      sent: 0,
      failed: 0,
      skipped: 0,
      sentJobIds: [],
    };
    const summary = buildRunSummary(startedAt, new Date(), counters, alertStats);
    logRunCounters(counters);
    log(`Run completed. New jobs: 0. Matches: 0. Runtime: ${summary.runtimeMs}ms.`);
    return summary;
  }

  log(`Classifying ${newJobs.length} jobs from RSS fields.`);

  const matchResults = await classifyJobs(newJobs, {
    apiKey: config.googleApiKey,
    descriptionCharCap: config.classifierDescriptionCharCap,
    continueOnError: true,
    onJobError: ({ job, error }) => {
      log(`Classifier fallback to NO for ${job.id}: ${formatError(error)}`);
    },
    rateLimit: {
      requestsPerMinute: config.geminiRequestsPerMinute,
      tokensPerMinute: config.geminiTokensPerMinute,
      safetyMargin: config.geminiTokenSafetyMargin,
      minDelayMs: config.geminiMinDelayMs,
    },
    fetcher: options.fetcher,
  });

  const matchCount = matchResults.filter((result) => result.match).length;
  counters.classified_yes_total = matchCount;

  const enrichedAlertResults = await enrichPositiveMatches(matchResults, newJobs, {
    allowHeadlessFallback: config.detailEnrichmentHeadlessFallbackEnabled,
    fetcher: options.fetcher,
  });
  const enrichmentFailureCount = countEnrichmentFailures(enrichedAlertResults);
  counters.enrichment_failures_total = enrichmentFailureCount;

  if (enrichmentFailureCount > 0) {
    log(`Detail enrichment fallback used for ${enrichmentFailureCount} matched job(s).`);
  }

  const alertStats = await sendTelegramAlerts(enrichedAlertResults, {
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    notifiedIds: state.notifiedIds,
    fetcher: options.fetcher,
  });
  counters.telegram_sent_total = alertStats.sent;
  counters.telegram_failed_total = alertStats.failed;

  await saveState(config.stateFilePath, {
    ...state,
    lastSeenJobId: newJobs[0]?.id ?? state.lastSeenJobId,
    latestSeenPubDate: getLatestSeenPubDate(state.latestSeenPubDate, newJobs),
    seenIds: mergeSeenIds(state.seenIds, newJobs.map((job) => job.id)),
    notifiedIds: mergeSeenIds(state.notifiedIds, alertStats.sentJobIds),
    classificationDecisions: mergeClassificationDecisions(
      state.classificationDecisions,
      matchResults,
    ),
  });

  const summary = buildRunSummary(startedAt, new Date(), counters, alertStats);

  logRunCounters(counters);
  log(`Telegram alerts: sent ${alertStats.sent}, failed ${alertStats.failed}, skipped ${alertStats.skipped}.`);
  log(`Run completed. New jobs: ${newJobs.length}. Matches: ${matchCount}. Runtime: ${summary.runtimeMs}ms.`);
  return summary;
}

export async function runDaily(options: RunOnceOptions = {}): Promise<void> {
  let running = false;

  const runGuarded = async () => {
    if (running) {
      log("Skipping scheduled run because the previous run is still in progress.");
      return;
    }

    running = true;
    try {
      await runOnce(options);
    } catch (error) {
      console.error(error);
      log("Run failed. State not updated.");
    } finally {
      running = false;
    }
  };

  await runGuarded();
  setInterval(() => {
    void runGuarded();
  }, DAILY_INTERVAL_MS);
}

export async function bootstrap(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runOptions: RunOnceOptions = {
    stateFilePath: args.stateFilePath,
  };

  if (args.schedule === "daily") {
    await runDaily(runOptions);
    return;
  }

  if (args.schedule) {
    throw new Error(`Unsupported schedule: ${args.schedule}`);
  }

  await runOnce(runOptions);
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function parseArgs(argv: string[]): { schedule?: string; stateFilePath?: string } {
  let schedule: string | undefined;
  let stateFilePath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--schedule" && argv[i + 1]) {
      schedule = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--schedule=")) {
      schedule = arg.slice("--schedule=".length);
      continue;
    }

    if (arg === "--state-file" && argv[i + 1]) {
      stateFilePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      stateFilePath = arg.slice("--state-file=".length);
    }
  }

  return { schedule, stateFilePath };
}

function buildRunSummary(
  startedAt: Date,
  finishedAt: Date,
  counters: RunCounters,
  alertStats: TelegramAlertStats,
): RunSummary {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    runtimeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    newJobsCount: counters.new_items_total,
    matchesCount: counters.classified_yes_total,
    telegramSentCount: counters.telegram_sent_total,
    telegramFailedCount: counters.telegram_failed_total,
    telegramSkippedCount: alertStats.skipped,
    sentJobIds: [...alertStats.sentJobIds],
    counters,
  };
}

function createRunCounters(): RunCounters {
  return {
    feed_items_total: 0,
    new_items_total: 0,
    classified_yes_total: 0,
    enrichment_failures_total: 0,
    telegram_sent_total: 0,
    telegram_failed_total: 0,
  };
}

function logRunCounters(counters: RunCounters): void {
  log(`Run summary counters: ${JSON.stringify(counters)}`);
}

function getLatestSeenPubDate(currentValue: string | null, jobs: Array<{ pubDate: string | null }>): string | null {
  let latestTimestamp = parseTimestamp(currentValue);

  for (const job of jobs) {
    const timestamp = parseTimestamp(job.pubDate);
    if (timestamp !== null && (latestTimestamp === null || timestamp > latestTimestamp)) {
      latestTimestamp = timestamp;
    }
  }

  return latestTimestamp === null ? null : new Date(latestTimestamp).toISOString();
}

function mergeSeenIds(existingIds: string[], newIds: string[]): string[] {
  const newIdSet = new Set(newIds.map((id) => id.trim()).filter((id) => id.length > 0));
  const merged = existingIds.filter((id) => !newIdSet.has(id.trim()));

  for (const id of newIds) {
    const trimmed = id.trim();
    if (!trimmed) {
      continue;
    }
    merged.push(trimmed);
  }

  return merged;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dedupeFeedJobsById(jobs: FeedJob[]): FeedJob[] {
  const deduped: FeedJob[] = [];
  const seen = new Set<string>();

  for (const job of jobs) {
    const id = job.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(job);
  }

  return deduped;
}

async function enrichPositiveMatches(
  results: JobMatchResult[],
  feedJobs: FeedJob[],
  options: {
    allowHeadlessFallback: boolean;
    fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  },
): Promise<TelegramAlertResult[]> {
  const jobsById = new Map(feedJobs.map((job) => [job.id, job]));
  const enrichedResults: TelegramAlertResult[] = [];

  for (const result of results) {
    if (!result.match) {
      enrichedResults.push(result);
      continue;
    }

    const sourceJob = jobsById.get(result.job.id);
    if (!sourceJob) {
      enrichedResults.push({
        ...result,
        enrichedJob: buildFallbackFromClassifierResult(
          result,
          "Could not find the matching RSS item during enrichment.",
        ),
      });
      continue;
    }

    try {
      const enrichedJob = await enrichFeedJob(sourceJob, {
        allowHeadlessFallback: options.allowHeadlessFallback,
        fetcher: options.fetcher,
      });

      enrichedResults.push({
        ...result,
        enrichedJob,
      });
    } catch (error) {
      enrichedResults.push({
        ...result,
        enrichedJob: buildFailedEnrichedFeedJob(
          sourceJob,
          `Unexpected enrichment error: ${formatError(error)}`,
        ),
      });
    }
  }

  return enrichedResults;
}

function countEnrichmentFailures(results: TelegramAlertResult[]): number {
  let failures = 0;

  for (const result of results) {
    if (!result.match) {
      continue;
    }

    if (result.enrichedJob?.detailFetchStatus === "failed") {
      failures += 1;
    }
  }

  return failures;
}

function buildFailedEnrichedFeedJob(job: FeedJob, errorMessage: string): EnrichedFeedJob {
  return {
    ...job,
    applyUrl: job.detailUrl,
    detailFetchStatus: "failed",
    enrichmentError: errorMessage,
  };
}

function buildFallbackFromClassifierResult(
  result: JobMatchResult,
  errorMessage: string,
): EnrichedFeedJob {
  return {
    id: result.job.id,
    title: result.job.title,
    detailUrl: result.job.detailUrl,
    pubDate: null,
    company: result.job.company,
    location: result.job.location,
    tags: result.job.tags,
    descriptionHtml: "",
    descriptionText: result.job.descriptionText,
    applyUrl: result.job.detailUrl,
    detailFetchStatus: "failed",
    enrichmentError: errorMessage,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function mergeClassificationDecisions(
  existing: ClassificationDecisionRecord[],
  results: JobMatchResult[],
): ClassificationDecisionRecord[] {
  const incomingByJobId = new Map<string, ClassificationDecisionRecord>();

  for (const result of results) {
    const jobId = result.job.id.trim();
    if (!jobId) {
      continue;
    }

    incomingByJobId.set(jobId, {
      jobId,
      match: result.match,
      rationale: result.rationale,
      rawResponse: result.rawResponse,
      decidedAt: result.decision.decidedAt,
      model: result.decision.model,
      promptTokens: result.decision.promptTokens,
      descriptionChars: result.decision.descriptionChars,
      descriptionCharsUsed: result.decision.descriptionCharsUsed,
      descriptionWasClipped: result.decision.descriptionWasClipped,
    });
  }

  const merged = existing.filter((entry) => !incomingByJobId.has(entry.jobId));
  for (const entry of incomingByJobId.values()) {
    merged.push(entry);
  }

  return merged;
}
