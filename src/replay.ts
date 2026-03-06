import dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";

import { classifyJobs, type ClassifierJob, type JobMatchResult } from "./classifier";
import { loadState, type ClassificationDecisionRecord } from "./state";

type ReplayOptions = {
  stateFilePath: string;
  limit?: number;
  gapMinutes: number;
  outputPath?: string;
  model?: string;
  descriptionCharCap?: number;
  fetchConcurrency: number;
  fetchTimeoutMs: number;
  geminiTimeoutMs: number;
};

type ParsedArgs = {
  stateFilePath: string;
  limit?: number;
  gapMinutes: number;
  outputPath?: string;
  model?: string;
  descriptionCharCap?: number;
  fetchConcurrency: number;
  fetchTimeoutMs: number;
  geminiTimeoutMs: number;
};

type PreparedJob = {
  job: ClassifierJob;
  decidedAt: string;
};

type FailedFetch = {
  jobId: string;
  decidedAt: string;
  error: string;
};

type FailedClassification = {
  jobId: string;
  decidedAt: string;
  error: string;
};

type ComparisonRow = {
  jobId: string;
  title: string;
  company: string | null;
  location: string | null;
  oldMatch: boolean;
  newMatch: boolean;
  changed: boolean;
  oldReasonCodes: string[];
  newReasonCodes: string[];
  oldRationale: string;
  newRationale: string;
  oldDecidedAt: string;
  newDecidedAt: string;
};

type ReplayReport = {
  generatedAt: string;
  options: {
    stateFilePath: string;
    gapMinutes: number;
    limit: number | null;
    fetchConcurrency: number;
    fetchTimeoutMs: number;
    model: string;
    descriptionCharCap: number;
    geminiTimeoutMs: number;
  };
  sourceWindow: {
    startedAt: string;
    finishedAt: string;
    windowDurationMinutes: number;
    selectedJobs: number;
  } | null;
  summary: {
    selectedJobs: number;
    fetchedJobs: number;
    fetchFailures: number;
    classificationFailures: number;
    classifiedJobs: number;
    changedVerdicts: number;
    changedToYes: number;
    changedToNo: number;
    oldYes: number;
    oldNo: number;
    newYes: number;
    newNo: number;
  };
  fetchFailures: FailedFetch[];
  classificationFailures: FailedClassification[];
  comparisons: ComparisonRow[];
};

const DEFAULT_STATE_FILE_PATH = "state.json";
const DEFAULT_GAP_MINUTES = 20;
const DEFAULT_FETCH_CONCURRENCY = 8;
const DEFAULT_DESCRIPTION_CHAR_CAP = 4_000;
const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_DIR = path.join("migration", "replay");
const DEFAULT_FETCH_TIMEOUT_MS = 45_000;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  dotenv.config();

  const apiKey = requiredEnv("GOOGLE_API_KEY");
  const replay = await runReplay({
    ...options,
    descriptionCharCap: options.descriptionCharCap ?? readPositiveIntegerEnv(
      "CLASSIFIER_DESCRIPTION_CHAR_CAP",
      DEFAULT_DESCRIPTION_CHAR_CAP,
    ),
    fetchTimeoutMs: options.fetchTimeoutMs,
    geminiTimeoutMs: options.geminiTimeoutMs,
  }, apiKey);

  const outputPath = options.outputPath ?? buildDefaultOutputPath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(replay, null, 2)}\n`, "utf-8");

  const runtimeMs = Date.now() - startedAt;
  console.log(`[replay] wrote report: ${path.resolve(outputPath)}`);
  console.log(
    `[replay] selected=${replay.summary.selectedJobs} fetched=${replay.summary.fetchedJobs} ` +
      `classified=${replay.summary.classifiedJobs} changed=${replay.summary.changedVerdicts}`,
  );
  console.log(`[replay] old_yes=${replay.summary.oldYes} new_yes=${replay.summary.newYes}`);
  console.log(`[replay] runtime_ms=${runtimeMs}`);
}

async function runReplay(options: ReplayOptions, apiKey: string): Promise<ReplayReport> {
  const state = await loadState(options.stateFilePath);
  const sorted = sortDecisionsByTimestamp(state.classificationDecisions);
  const groups = splitIntoRunGroups(sorted, options.gapMinutes);
  const lastGroup = groups[groups.length - 1] ?? [];

  const selected = typeof options.limit === "number" ? lastGroup.slice(-options.limit) : lastGroup;
  const jobsById = new Map(state.classificationDecisions.map((record) => [record.jobId, record]));

  const prepared = await mapLimit<
    ClassificationDecisionRecord,
    { prepared: PreparedJob } | { failure: FailedFetch }
  >(selected, options.fetchConcurrency, async (record) => {
    try {
      const preparedJob = await prepareJobFromPage(record, options.fetchTimeoutMs);
      if (!preparedJob) {
        return {
          failure: {
            jobId: record.jobId,
            decidedAt: record.decidedAt,
            error: "Could not extract JobPosting metadata from page.",
          },
        };
      }
      return { prepared: preparedJob };
    } catch (error) {
      return {
        failure: {
          jobId: record.jobId,
          decidedAt: record.decidedAt,
          error: toErrorMessage(error),
        },
      };
    }
  });

  const successfulJobs: PreparedJob[] = [];
  const fetchFailures: FailedFetch[] = [];
  for (const row of prepared) {
    if ("prepared" in row) {
      successfulJobs.push(row.prepared);
      continue;
    }
    fetchFailures.push(row.failure);
  }

  const model = options.model ?? "gemma-3-27b-it";
  const preparedById = new Map(successfulJobs.map((entry) => [entry.job.id, entry]));
  const classificationFailures: FailedClassification[] = [];
  const classified = await classifyJobs(
    successfulJobs.map((entry) => entry.job),
    {
      apiKey,
      model,
      timeoutMs: options.geminiTimeoutMs,
      descriptionCharCap: options.descriptionCharCap,
      continueOnError: true,
      onJobError: ({ job, error }) => {
        classificationFailures.push({
          jobId: job.id,
          decidedAt: preparedById.get(job.id)?.decidedAt ?? "",
          error: toErrorMessage(error),
        });
      },
      rateLimit: {
        requestsPerMinute: readOptionalNumberEnv("GEMINI_REQUESTS_PER_MINUTE"),
        tokensPerMinute: readOptionalNumberEnv("GEMINI_TOKENS_PER_MINUTE"),
        safetyMargin: readOptionalNumberEnv("GEMINI_TOKEN_SAFETY_MARGIN"),
        minDelayMs: readOptionalNumberEnv("GEMINI_MIN_DELAY_MS"),
      },
    },
  );

  const compared = compareResults(classified, successfulJobs, jobsById);
  const summary = buildSummary(
    selected.length,
    successfulJobs.length,
    fetchFailures.length,
    classificationFailures.length,
    compared,
  );

  const sourceWindow = buildSourceWindow(lastGroup);
  return {
    generatedAt: new Date().toISOString(),
    options: {
      stateFilePath: options.stateFilePath,
      gapMinutes: options.gapMinutes,
      limit: options.limit ?? null,
      fetchConcurrency: options.fetchConcurrency,
      fetchTimeoutMs: options.fetchTimeoutMs,
      model,
      descriptionCharCap: options.descriptionCharCap ?? DEFAULT_DESCRIPTION_CHAR_CAP,
      geminiTimeoutMs: options.geminiTimeoutMs,
    },
    sourceWindow,
    summary,
    fetchFailures,
    classificationFailures,
    comparisons: compared,
  };
}

function buildSummary(
  selectedJobs: number,
  fetchedJobs: number,
  fetchFailures: number,
  classificationFailures: number,
  comparisons: ComparisonRow[],
): ReplayReport["summary"] {
  let changedVerdicts = 0;
  let changedToYes = 0;
  let changedToNo = 0;
  let oldYes = 0;
  let oldNo = 0;
  let newYes = 0;
  let newNo = 0;

  for (const row of comparisons) {
    if (row.oldMatch) {
      oldYes += 1;
    } else {
      oldNo += 1;
    }

    if (row.newMatch) {
      newYes += 1;
    } else {
      newNo += 1;
    }

    if (!row.changed) {
      continue;
    }

    changedVerdicts += 1;
    if (row.newMatch) {
      changedToYes += 1;
    } else {
      changedToNo += 1;
    }
  }

  return {
    selectedJobs,
    fetchedJobs,
    fetchFailures,
    classificationFailures,
    classifiedJobs: comparisons.length,
    changedVerdicts,
    changedToYes,
    changedToNo,
    oldYes,
    oldNo,
    newYes,
    newNo,
  };
}

function compareResults(
  classified: JobMatchResult[],
  preparedJobs: PreparedJob[],
  jobsById: Map<string, ClassificationDecisionRecord>,
): ComparisonRow[] {
  const preparedById = new Map(preparedJobs.map((entry) => [entry.job.id, entry]));
  const comparisons: ComparisonRow[] = [];

  for (const result of classified) {
    const jobId = result.job.id;
    const previous = jobsById.get(jobId);
    const prepared = preparedById.get(jobId);
    if (!previous || !prepared) {
      continue;
    }

    const oldReasonCodes = extractReasonCodes(previous.rawResponse);
    const newReasonCodes = extractReasonCodes(result.rawResponse);
    const changed = previous.match !== result.match;

    comparisons.push({
      jobId,
      title: result.job.title,
      company: result.job.company,
      location: result.job.location,
      oldMatch: previous.match,
      newMatch: result.match,
      changed,
      oldReasonCodes,
      newReasonCodes,
      oldRationale: previous.rationale,
      newRationale: result.rationale,
      oldDecidedAt: previous.decidedAt,
      newDecidedAt: result.decision.decidedAt,
    });
  }

  return comparisons;
}

function extractReasonCodes(rawResponse: string): string[] {
  const match = /^\s*REASON_CODES\s*:\s*(.+)$/im.exec(rawResponse);
  if (!match?.[1]) {
    return [];
  }

  const codes: string[] = [];
  const seen = new Set<string>();
  for (const token of match[1].split(",")) {
    const code = token
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_ ]+/g, "")
      .replace(/\s+/g, "_");
    if (!code || seen.has(code)) {
      continue;
    }
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

async function prepareJobFromPage(
  record: ClassificationDecisionRecord,
  timeoutMs: number,
): Promise<PreparedJob | null> {
  const html = await fetchText(record.jobId, timeoutMs);
  const metadata = extractJobPostingMetadata(html);
  if (!metadata) {
    return null;
  }

  return {
    decidedAt: record.decidedAt,
    job: {
      id: record.jobId,
      detailUrl: record.jobId,
      title: metadata.title,
      company: metadata.company,
      location: metadata.location,
      tags: metadata.tags,
      descriptionText: metadata.descriptionText,
    },
  };
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "vibe-coder-job-agent/0.1",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      if (attempt < maxAttempts - 1 && isRetryableFetchError(error)) {
        await sleep(getRetryDelayMs(attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("fetchText exhausted retry attempts.");
}

type JobPostingMetadata = {
  title: string;
  company: string | null;
  location: string | null;
  tags: string[];
  descriptionText: string;
};

function extractJobPostingMetadata(html: string): JobPostingMetadata | null {
  const jsonLdBlocks = extractJsonLdBlocks(html);
  for (const block of jsonLdBlocks) {
    const parsed = parseJson(block);
    if (!parsed) {
      continue;
    }

    const postings = findJobPostingNodes(parsed);
    for (const posting of postings) {
      const title = readString(posting["title"]) ?? extractTitleFromDocument(html);
      const descriptionHtml = readString(posting["description"]) ?? "";
      const descriptionText = htmlToPlainText(descriptionHtml);
      if (!title || !descriptionText) {
        continue;
      }

      const company = readCompany(posting);
      const location = readLocation(posting);
      const tags = readTags(posting);

      return {
        title,
        company,
        location,
        tags,
        descriptionText,
      };
    }
  }

  return null;
}

function extractJsonLdBlocks(html: string): string[] {
  const regex = /<script\b[^>]*type\s*=\s*("|')application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const value = (match[2] ?? "").trim();
    if (value) {
      blocks.push(value);
    }
  }
  return blocks;
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const decoded = decodeHtmlEntities(raw);
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
}

function findJobPostingNodes(value: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    if (hasSchemaType(current, "JobPosting")) {
      nodes.push(current);
    }

    for (const child of Object.values(current)) {
      visit(child);
    }
  };

  visit(value);
  return nodes;
}

function hasSchemaType(node: Record<string, unknown>, typeName: string): boolean {
  const value = node["@type"];
  if (typeof value === "string") {
    return value.toLowerCase() === typeName.toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === "string" && entry.toLowerCase() === typeName.toLowerCase(),
    );
  }
  return false;
}

function readCompany(posting: Record<string, unknown>): string | null {
  const hiringOrg = posting["hiringOrganization"];
  if (!isRecord(hiringOrg)) {
    return null;
  }
  return readString(hiringOrg["name"]);
}

function readLocation(posting: Record<string, unknown>): string | null {
  const values = collectJobLocations(posting["jobLocation"]);
  if (values.length > 0) {
    return values.join(", ");
  }

  const fallback = readString(posting["jobLocationType"]);
  return fallback ?? null;
}

function collectJobLocations(value: unknown): string[] {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const locations: string[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }

    const address = isRecord(entry["address"]) ? entry["address"] : entry;
    const location = [
      readString(address["addressLocality"]),
      readString(address["addressRegion"]),
      readString(address["addressCountry"]),
    ]
      .filter((segment): segment is string => Boolean(segment))
      .join(", ");

    if (!location || seen.has(location)) {
      continue;
    }
    seen.add(location);
    locations.push(location);
  }

  return locations;
}

function readTags(posting: Record<string, unknown>): string[] {
  const candidates: string[] = [];

  const directSkills = posting["skills"];
  if (typeof directSkills === "string") {
    candidates.push(...splitTags(directSkills));
  } else if (Array.isArray(directSkills)) {
    for (const entry of directSkills) {
      if (typeof entry === "string") {
        candidates.push(...splitTags(entry));
      }
    }
  }

  const employmentType = posting["employmentType"];
  if (typeof employmentType === "string") {
    candidates.push(...splitTags(employmentType));
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function splitTags(value: string): string[] {
  return value
    .split(/[|,;/]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractTitleFromDocument(html: string): string | null {
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!titleMatch?.[1]) {
    return null;
  }
  const normalized = htmlToPlainText(titleMatch[1]);
  if (!normalized) {
    return null;
  }

  const pipeIndex = normalized.indexOf("|");
  if (pipeIndex <= 0) {
    return normalized;
  }

  return normalized.slice(0, pipeIndex).trim();
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sortDecisionsByTimestamp(records: ClassificationDecisionRecord[]): ClassificationDecisionRecord[] {
  return [...records].sort(
    (a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt),
  );
}

function splitIntoRunGroups(
  sortedRecords: ClassificationDecisionRecord[],
  gapMinutes: number,
): ClassificationDecisionRecord[][] {
  const gapMs = Math.max(1, Math.floor(gapMinutes * 60_000));
  const groups: ClassificationDecisionRecord[][] = [];
  let current: ClassificationDecisionRecord[] = [];

  for (const record of sortedRecords) {
    const timestamp = Date.parse(record.decidedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (current.length === 0) {
      current = [record];
      continue;
    }

    const previousTimestamp = Date.parse(current[current.length - 1].decidedAt);
    if (!Number.isFinite(previousTimestamp) || timestamp - previousTimestamp > gapMs) {
      groups.push(current);
      current = [record];
      continue;
    }

    current.push(record);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function buildSourceWindow(
  records: ClassificationDecisionRecord[],
): ReplayReport["sourceWindow"] {
  if (records.length === 0) {
    return null;
  }

  const startedAt = records[0].decidedAt;
  const finishedAt = records[records.length - 1].decidedAt;
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));

  return {
    startedAt,
    finishedAt,
    windowDurationMinutes: Number((durationMs / 60_000).toFixed(2)),
    selectedJobs: records.length,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  let stateFilePath = DEFAULT_STATE_FILE_PATH;
  let limit: number | undefined;
  let gapMinutes = DEFAULT_GAP_MINUTES;
  let outputPath: string | undefined;
  let model: string | undefined;
  let descriptionCharCap: number | undefined;
  let fetchConcurrency = DEFAULT_FETCH_CONCURRENCY;
  let fetchTimeoutMs = readPositiveIntegerEnv("REPLAY_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  let geminiTimeoutMs = readPositiveIntegerEnv("GEMINI_TIMEOUT_MS", DEFAULT_GEMINI_TIMEOUT_MS);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if ((arg === "--state-file" || arg === "--stateFile") && argv[i + 1]) {
      stateFilePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--state-file=") || arg.startsWith("--stateFile=")) {
      stateFilePath = arg.slice(arg.indexOf("=") + 1);
      continue;
    }

    if (arg === "--limit" && argv[i + 1]) {
      limit = parsePositiveInteger(argv[i + 1], "--limit");
      i += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(arg.slice("--limit=".length), "--limit");
      continue;
    }

    if ((arg === "--gap-minutes" || arg === "--gapMinutes") && argv[i + 1]) {
      gapMinutes = parsePositiveNumber(argv[i + 1], "--gap-minutes");
      i += 1;
      continue;
    }

    if (arg.startsWith("--gap-minutes=") || arg.startsWith("--gapMinutes=")) {
      gapMinutes = parsePositiveNumber(arg.slice(arg.indexOf("=") + 1), "--gap-minutes");
      continue;
    }

    if (arg === "--output" && argv[i + 1]) {
      outputPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--model" && argv[i + 1]) {
      model = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    if ((arg === "--description-char-cap" || arg === "--descriptionCharCap") && argv[i + 1]) {
      descriptionCharCap = parsePositiveInteger(argv[i + 1], "--description-char-cap");
      i += 1;
      continue;
    }

    if (arg.startsWith("--description-char-cap=") || arg.startsWith("--descriptionCharCap=")) {
      descriptionCharCap = parsePositiveInteger(
        arg.slice(arg.indexOf("=") + 1),
        "--description-char-cap",
      );
      continue;
    }

    if ((arg === "--fetch-concurrency" || arg === "--fetchConcurrency") && argv[i + 1]) {
      fetchConcurrency = parsePositiveInteger(argv[i + 1], "--fetch-concurrency");
      i += 1;
      continue;
    }

    if (arg.startsWith("--fetch-concurrency=") || arg.startsWith("--fetchConcurrency=")) {
      fetchConcurrency = parsePositiveInteger(arg.slice(arg.indexOf("=") + 1), "--fetch-concurrency");
      continue;
    }

    if ((arg === "--fetch-timeout-ms" || arg === "--fetchTimeoutMs") && argv[i + 1]) {
      fetchTimeoutMs = parsePositiveInteger(argv[i + 1], "--fetch-timeout-ms");
      i += 1;
      continue;
    }

    if (arg.startsWith("--fetch-timeout-ms=") || arg.startsWith("--fetchTimeoutMs=")) {
      fetchTimeoutMs = parsePositiveInteger(arg.slice(arg.indexOf("=") + 1), "--fetch-timeout-ms");
      continue;
    }

    if ((arg === "--gemini-timeout-ms" || arg === "--geminiTimeoutMs") && argv[i + 1]) {
      geminiTimeoutMs = parsePositiveInteger(argv[i + 1], "--gemini-timeout-ms");
      i += 1;
      continue;
    }

    if (arg.startsWith("--gemini-timeout-ms=") || arg.startsWith("--geminiTimeoutMs=")) {
      geminiTimeoutMs = parsePositiveInteger(arg.slice(arg.indexOf("=") + 1), "--gemini-timeout-ms");
      continue;
    }
  }

  return {
    stateFilePath,
    limit,
    gapMinutes,
    outputPath,
    model,
    descriptionCharCap,
    fetchConcurrency,
    fetchTimeoutMs,
    geminiTimeoutMs,
  };
}

function parsePositiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parsePositiveNumber(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("abort") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket")
  );
}

function getRetryDelayMs(attempt: number): number {
  const baseMs = 1_000;
  const delayMs = baseMs * 2 ** attempt;
  return Math.min(10_000, delayMs);
}

function buildDefaultOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_OUTPUT_DIR, `replay-last-run-${timestamp}.json`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function readOptionalNumberEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }
  return parsed;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  return parsePositiveInteger(value, name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(safeLimit, items.length); i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
