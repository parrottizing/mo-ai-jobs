import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { runOnceWithSummary, type RunSummary } from "./index";

const execFileAsync = promisify(execFile);

const DEFAULT_PHASE8_DIR = "migration/phase8";
const DEFAULT_REPORT_PATH = path.join(DEFAULT_PHASE8_DIR, "validation-report.json");
const DEFAULT_STATE_FILE_PATH = path.join(DEFAULT_PHASE8_DIR, "state.phase8.test.json");
const DEFAULT_BASELINE_METRICS_PATH = "migration/phase0/baseline-metrics.json";

const MOCK_RSS_FEED_URL = "https://mock.moaijobs.local/ai-jobs.rss";
const MOCK_RSS_FEED_PAGE_2_URL = `${MOCK_RSS_FEED_URL}?paged=2`;
const MATCHED_JOB_DETAIL_URL = "https://mock.moaijobs.local/jobs/senior-ai-automation-engineer";
const UNMATCHED_JOB_DETAIL_URL = "https://mock.moaijobs.local/jobs/staff-backend-engineer";
const MATCHED_JOB_APPLY_URL = "https://careers.example.com/jobs/senior-ai-automation-engineer";

const TEST_ENV_VALUES: Record<string, string> = {
  GOOGLE_API_KEY: "phase8-test-google-api-key",
  TELEGRAM_BOT_TOKEN: "phase8-test-telegram-bot-token",
  TELEGRAM_CHAT_ID: "phase8-test-chat-id",
  RSS_FEED_URL: MOCK_RSS_FEED_URL,
  RSS_MAX_PAGES_PER_RUN: "2",
  DETAIL_ENRICHMENT_HEADLESS_FALLBACK_ENABLED: "false",
  GEMINI_TOKENS_PER_MINUTE: "1000000",
  GEMINI_TOKEN_SAFETY_MARGIN: "1",
  GEMINI_MIN_DELAY_MS: "0",
};

type Phase8Options = {
  stateFilePath?: string;
  reportPath?: string;
  baselineMetricsPath?: string;
};

type CommandResult = {
  command: string;
  success: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
};

type CounterSet = {
  total: number;
  feed: number;
  detailTotal: number;
  detailMatched: number;
  detailUnmatched: number;
  classifier: number;
  telegram: number;
};

type ObservationState = {
  counters: CounterSet;
  telegramMessages: string[];
};

type ObservationSnapshot = {
  counters: CounterSet;
  telegramMessages: string[];
};

type RunObservation = {
  counters: CounterSet;
  telegramMessages: string[];
};

type ComparisonResult = {
  status: "pass" | "fail" | "not_available";
  baseline: number | null;
  current: number;
  delta: number | null;
  message: string;
};

type Phase8Report = {
  generatedAt: string;
  artifacts: {
    reportPath: string;
    stateFilePath: string;
    baselineMetricsPath: string;
  };
  commandResults: {
    typecheck: CommandResult;
    compile: CommandResult;
  };
  runResults: {
    firstRun: {
      summary: RunSummary;
      observation: RunObservation;
    };
    secondRun: {
      summary: RunSummary;
      observation: RunObservation;
    };
  };
  checks: {
    run_with_safe_test_credentials: boolean;
    no_duplicate_alerts_on_unchanged_feed: boolean;
    matched_jobs_include_external_apply_links: boolean;
    unmatched_jobs_do_not_fetch_details: boolean;
    runtime_vs_baseline: ComparisonResult;
    request_count_vs_baseline: ComparisonResult;
  };
  allChecksPassed: boolean;
};

export async function runPhase8(options: Phase8Options = {}): Promise<{ reportPath: string; report: Phase8Report }> {
  const stateFilePath = options.stateFilePath ?? DEFAULT_STATE_FILE_PATH;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const baselineMetricsPath = options.baselineMetricsPath ?? DEFAULT_BASELINE_METRICS_PATH;

  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  await fs.rm(stateFilePath, { force: true });

  const typecheck = await runCommand("npm", ["run", "typecheck"]);
  assertCommandSucceeded(typecheck);

  const compile = await runCommand("npx", ["tsc"]);
  assertCommandSucceeded(compile);

  const observation = createObservationState();
  const fetcher = createMockFetcher(observation);

  const originalEnv = captureEnv(Object.keys(TEST_ENV_VALUES));
  applyTestEnv(TEST_ENV_VALUES);

  let firstRunSummary: RunSummary;
  let secondRunSummary: RunSummary;
  let firstRunObservation: RunObservation;
  let secondRunObservation: RunObservation;

  try {
    const beforeFirst = snapshotObservation(observation);
    firstRunSummary = await runOnceWithSummary({ stateFilePath, fetcher });
    const afterFirst = snapshotObservation(observation);
    firstRunObservation = diffObservation(beforeFirst, afterFirst);

    const beforeSecond = snapshotObservation(observation);
    secondRunSummary = await runOnceWithSummary({ stateFilePath, fetcher });
    const afterSecond = snapshotObservation(observation);
    secondRunObservation = diffObservation(beforeSecond, afterSecond);
  } finally {
    restoreEnv(originalEnv);
  }

  const baselineMetrics = await readJsonIfExists(baselineMetricsPath);
  const baselineRuntimeMs = extractBaselineRuntimeMs(baselineMetrics);
  const baselineRequestCount = extractBaselineRequestCount(baselineMetrics);

  const runtimeComparison = compareAgainstBaseline(
    baselineRuntimeMs,
    firstRunSummary.runtimeMs,
    "runtime (ms)",
  );
  const requestCountComparison = compareAgainstBaseline(
    baselineRequestCount,
    firstRunObservation.counters.total,
    "request count",
  );

  const checks = {
    run_with_safe_test_credentials:
      firstRunSummary.newJobsCount > 0 &&
      firstRunSummary.matchesCount > 0 &&
      firstRunSummary.telegramSentCount > 0,
    no_duplicate_alerts_on_unchanged_feed:
      firstRunSummary.telegramSentCount === 1 &&
      secondRunSummary.telegramSentCount === 0 &&
      secondRunSummary.newJobsCount === 0 &&
      secondRunObservation.counters.telegram === 0,
    matched_jobs_include_external_apply_links: firstRunObservation.telegramMessages.some((message) =>
      message.includes(`Apply: ${MATCHED_JOB_APPLY_URL}`),
    ),
    unmatched_jobs_do_not_fetch_details:
      firstRunObservation.counters.detailUnmatched === 0 &&
      secondRunObservation.counters.detailUnmatched === 0,
    runtime_vs_baseline: runtimeComparison,
    request_count_vs_baseline: requestCountComparison,
  };

  const allChecksPassed =
    checks.run_with_safe_test_credentials &&
    checks.no_duplicate_alerts_on_unchanged_feed &&
    checks.matched_jobs_include_external_apply_links &&
    checks.unmatched_jobs_do_not_fetch_details &&
    checks.runtime_vs_baseline.status !== "fail" &&
    checks.request_count_vs_baseline.status === "pass";

  const report: Phase8Report = {
    generatedAt: new Date().toISOString(),
    artifacts: {
      reportPath,
      stateFilePath,
      baselineMetricsPath,
    },
    commandResults: {
      typecheck,
      compile,
    },
    runResults: {
      firstRun: {
        summary: firstRunSummary,
        observation: firstRunObservation,
      },
      secondRun: {
        summary: secondRunSummary,
        observation: secondRunObservation,
      },
    },
    checks,
    allChecksPassed,
  };

  await writeJsonFile(reportPath, report);

  return {
    reportPath,
    report,
  };
}

function createObservationState(): ObservationState {
  return {
    counters: {
      total: 0,
      feed: 0,
      detailTotal: 0,
      detailMatched: 0,
      detailUnmatched: 0,
      classifier: 0,
      telegram: 0,
    },
    telegramMessages: [],
  };
}

function createMockFetcher(
  observation: ObservationState,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const rssXml = buildMockRssFeedXml();
  const matchedDetailHtml = [
    "<html><body>",
    `<a href="${MATCHED_JOB_APPLY_URL}">Apply Now</a>`,
    "</body></html>",
  ].join("");
  const unmatchedDetailHtml = "<html><body><h1>Staff Backend Engineer</h1></body></html>";

  return async (input, init) => {
    const url = resolveRequestUrl(input);
    observation.counters.total += 1;

    if (url === MOCK_RSS_FEED_URL) {
      observation.counters.feed += 1;
      return new Response(rssXml, {
        status: 200,
        headers: {
          "Content-Type": "application/rss+xml",
        },
      });
    }

    if (url === MOCK_RSS_FEED_PAGE_2_URL) {
      observation.counters.feed += 1;
      return new Response("", {
        status: 404,
        headers: {
          "Content-Type": "application/rss+xml",
        },
      });
    }

    if (url === MATCHED_JOB_DETAIL_URL) {
      observation.counters.detailTotal += 1;
      observation.counters.detailMatched += 1;
      return new Response(matchedDetailHtml, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    if (url === UNMATCHED_JOB_DETAIL_URL) {
      observation.counters.detailTotal += 1;
      observation.counters.detailUnmatched += 1;
      return new Response(unmatchedDetailHtml, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    if (isGeminiRequest(url)) {
      observation.counters.classifier += 1;
      const prompt = extractPromptFromGeminiRequest(init?.body);
      const isMatch = prompt.includes("Senior AI Automation Engineer");
      const payload = {
        candidates: [
          {
            content: {
              parts: [{ text: isMatch ? "YES" : "NO" }],
            },
          },
        ],
      };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    if (isTelegramRequest(url)) {
      observation.counters.telegram += 1;
      const text = extractTelegramTextFromRequest(init?.body);
      if (text) {
        observation.telegramMessages.push(text);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: observation.telegramMessages.length,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    throw new Error(`Unexpected network request during Phase 8 validation: ${url}`);
  };
}

function buildMockRssFeedXml(): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<rss version=\"2.0\">",
    "  <channel>",
    "    <title>Mock MoAIJobs Feed</title>",
    "    <item>",
    "      <guid>phase8-job-yes</guid>",
    "      <title>Senior AI Automation Engineer</title>",
    `      <link>${MATCHED_JOB_DETAIL_URL}</link>`,
    "      <pubDate>Fri, 20 Feb 2026 10:00:00 GMT</pubDate>",
    "      <description><![CDATA[<p>Company: Mock Labs</p><p>Location: Remote</p><p>Tags: AI, Automation</p>]]></description>",
    "    </item>",
    "    <item>",
    "      <guid>phase8-job-no</guid>",
    "      <title>Staff Backend Engineer</title>",
    `      <link>${UNMATCHED_JOB_DETAIL_URL}</link>`,
    "      <pubDate>Fri, 20 Feb 2026 09:00:00 GMT</pubDate>",
    "      <description><![CDATA[<p>Company: Legacy Systems</p><p>Location: Onsite</p><p>Tags: Backend, Java</p>]]></description>",
    "    </item>",
    "  </channel>",
    "</rss>",
  ].join("\n");
}

function isGeminiRequest(url: string): boolean {
  return (
    url.startsWith("https://generativelanguage.googleapis.com/") &&
    url.includes(":generateContent")
  );
}

function isTelegramRequest(url: string): boolean {
  return url.startsWith("https://api.telegram.org/bot") && url.endsWith("/sendMessage");
}

function extractPromptFromGeminiRequest(body: RequestInit["body"]): string {
  const raw = requestBodyToString(body);
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as {
      contents?: Array<{
        parts?: Array<{
          text?: string;
        }>;
      }>;
    };

    return (
      parsed.contents?.[0]?.parts
        ?.map((part) => part.text ?? "")
        .join(" ")
        .trim() ?? ""
    );
  } catch {
    return "";
  }
}

function extractTelegramTextFromRequest(body: RequestInit["body"]): string {
  const raw = requestBodyToString(body);
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function requestBodyToString(body: RequestInit["body"]): string {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString("utf-8");
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf-8");
  }

  return "";
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function snapshotObservation(observation: ObservationState): ObservationSnapshot {
  return {
    counters: { ...observation.counters },
    telegramMessages: [...observation.telegramMessages],
  };
}

function diffObservation(
  before: ObservationSnapshot,
  after: ObservationSnapshot,
): RunObservation {
  return {
    counters: {
      total: after.counters.total - before.counters.total,
      feed: after.counters.feed - before.counters.feed,
      detailTotal: after.counters.detailTotal - before.counters.detailTotal,
      detailMatched: after.counters.detailMatched - before.counters.detailMatched,
      detailUnmatched: after.counters.detailUnmatched - before.counters.detailUnmatched,
      classifier: after.counters.classifier - before.counters.classifier,
      telegram: after.counters.telegram - before.counters.telegram,
    },
    telegramMessages: after.telegramMessages.slice(before.telegramMessages.length),
  };
}

function captureEnv(keys: string[]): Record<string, string | undefined> {
  const captured: Record<string, string | undefined> = {};
  for (const key of keys) {
    captured[key] = process.env[key];
  }
  return captured;
}

function applyTestEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const startedAt = Date.now();
  const renderedCommand = [command, ...args].join(" ");

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      command: renderedCommand,
      success: true,
      exitCode: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      stdout,
      stderr,
    };
  } catch (error) {
    const commandError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      command: renderedCommand,
      success: false,
      exitCode:
        typeof commandError.code === "number"
          ? commandError.code
          : commandError.code === undefined
            ? 1
            : Number.parseInt(commandError.code, 10) || 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? commandError.message ?? "",
    };
  }
}

function assertCommandSucceeded(result: CommandResult): void {
  if (result.success) {
    return;
  }

  throw new Error(
    [
      `Command failed: ${result.command}`,
      `Exit code: ${result.exitCode}`,
      result.stdout ? `STDOUT:\n${result.stdout}` : "",
      result.stderr ? `STDERR:\n${result.stderr}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as unknown;
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function extractBaselineRuntimeMs(payload: unknown): number | null {
  const metrics = readRecord(payload, "metrics");
  const runSummary = readRecord(payload, "runSummary");
  return (
    readFiniteNumber(metrics, "runtimeMs") ??
    readFiniteNumber(runSummary, "runtimeMs") ??
    null
  );
}

function extractBaselineRequestCount(payload: unknown): number | null {
  const metrics = readRecord(payload, "metrics");
  const runSummary = readRecord(payload, "runSummary");
  const counters = readRecord(runSummary, "counters");

  return (
    readFiniteNumber(metrics, "requestCount") ??
    readFiniteNumber(metrics, "requestsTotal") ??
    readFiniteNumber(runSummary, "requestCount") ??
    readFiniteNumber(runSummary, "requestsTotal") ??
    readFiniteNumber(counters, "request_count_total") ??
    readFiniteNumber(counters, "requests_total") ??
    readFiniteNumber(counters, "network_requests_total") ??
    null
  );
}

function compareAgainstBaseline(
  baselineValue: number | null,
  currentValue: number,
  label: string,
): ComparisonResult {
  if (baselineValue === null) {
    return {
      status: "not_available",
      baseline: null,
      current: currentValue,
      delta: null,
      message: `No baseline ${label} found in migration baseline artifacts.`,
    };
  }

  const delta = currentValue - baselineValue;
  if (currentValue <= baselineValue) {
    return {
      status: "pass",
      baseline: baselineValue,
      current: currentValue,
      delta,
      message: `Current ${label} is less than or equal to baseline.`,
    };
  }

  return {
    status: "fail",
    baseline: baselineValue,
    current: currentValue,
    delta,
    message: `Current ${label} is higher than baseline.`,
  };
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readFiniteNumber(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!value) {
    return null;
  }

  const numeric = value[key];
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    return null;
  }

  return numeric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function parseArgs(argv: string[]): Required<Phase8Options> {
  let stateFilePath = DEFAULT_STATE_FILE_PATH;
  let reportPath = DEFAULT_REPORT_PATH;
  let baselineMetricsPath = DEFAULT_BASELINE_METRICS_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--state-file" && argv[i + 1]) {
      stateFilePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--state-file=")) {
      stateFilePath = arg.slice("--state-file=".length);
      continue;
    }

    if (arg === "--report-path" && argv[i + 1]) {
      reportPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--report-path=")) {
      reportPath = arg.slice("--report-path=".length);
      continue;
    }

    if (arg === "--baseline-metrics-path" && argv[i + 1]) {
      baselineMetricsPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--baseline-metrics-path=")) {
      baselineMetricsPath = arg.slice("--baseline-metrics-path=".length);
      continue;
    }

    throw new Error(`Unsupported argument: ${arg}`);
  }

  return {
    stateFilePath,
    reportPath,
    baselineMetricsPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { reportPath, report } = await runPhase8(options);

  console.log(`Phase 8 report written: ${path.resolve(reportPath)}`);
  console.log(`All checks passed: ${report.allChecksPassed}`);
  console.log(`Runtime comparison: ${report.checks.runtime_vs_baseline.message}`);
  console.log(`Request comparison: ${report.checks.request_count_vs_baseline.message}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
