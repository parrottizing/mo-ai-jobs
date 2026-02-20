import { promises as fs } from "node:fs";
import path from "node:path";

import { runOnceWithSummary, type RunSummary } from "./index";
import { loadState, type JobState } from "./state";

const DEFAULT_PHASE0_DIR = "migration/phase0";
const DEFAULT_BASELINE_METRICS_PATH = path.join(DEFAULT_PHASE0_DIR, "baseline-metrics.json");
const DEFAULT_STATE_BACKUP_DIR = path.join(DEFAULT_PHASE0_DIR, "state-backups");
const DEFAULT_STATE_SCHEMA_PATH = path.join(DEFAULT_PHASE0_DIR, "state-schema-v0.md");

type Phase0Options = {
  stateFilePath?: string;
  metricsPath?: string;
  backupDir?: string;
  schemaPath?: string;
};

type Phase0Artifacts = {
  stateBackupPath: string;
  stateSchemaPath: string;
  baselineMetricsPath: string;
  runSummary: RunSummary;
};

type BaselineMetrics = {
  recordedAt: string;
  stateFilePath: string;
  stateBeforeRun: JobState;
  metrics: {
    newJobsCount: number;
    matchesCount: number;
    runtimeMs: number;
    telegramSentCount: number;
    requestCount: number;
  };
  runSummary: RunSummary;
};

export async function runPhase0(options: Phase0Options = {}): Promise<Phase0Artifacts> {
  const stateFilePath = options.stateFilePath ?? "state.json";
  const metricsPath = options.metricsPath ?? DEFAULT_BASELINE_METRICS_PATH;
  const backupDir = options.backupDir ?? DEFAULT_STATE_BACKUP_DIR;
  const schemaPath = options.schemaPath ?? DEFAULT_STATE_SCHEMA_PATH;

  const stateBeforeRun = await loadState(stateFilePath);
  const stateBackupPath = await backupStateFile(stateFilePath, backupDir);

  const stateSchemaDoc = buildStateSchemaDoc(stateFilePath, stateBeforeRun);
  await writeTextFile(schemaPath, stateSchemaDoc);

  const { fetcher, getRequestCount } = createCountingFetcher();
  const runSummary = await runOnceWithSummary({ stateFilePath, fetcher });
  const baselinePayload: BaselineMetrics = {
    recordedAt: new Date().toISOString(),
    stateFilePath,
    stateBeforeRun,
    metrics: {
      newJobsCount: runSummary.newJobsCount,
      matchesCount: runSummary.matchesCount,
      runtimeMs: runSummary.runtimeMs,
      telegramSentCount: runSummary.telegramSentCount,
      requestCount: getRequestCount(),
    },
    runSummary,
  };
  await writeJsonFile(metricsPath, baselinePayload);

  return {
    stateBackupPath,
    stateSchemaPath: schemaPath,
    baselineMetricsPath: metricsPath,
    runSummary,
  };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function createCountingFetcher(): {
  fetcher: Fetcher;
  getRequestCount: () => number;
} {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  const baseFetcher: Fetcher = globalThis.fetch.bind(globalThis);
  let requestCount = 0;

  const fetcher: Fetcher = async (input, init) => {
    requestCount += 1;
    return baseFetcher(input, init);
  };

  return {
    fetcher,
    getRequestCount: () => requestCount,
  };
}

async function backupStateFile(stateFilePath: string, backupDir: string): Promise<string> {
  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `state-backup-${timestamp}.json`);
  await fs.copyFile(stateFilePath, backupPath);
  return backupPath;
}

function buildStateSchemaDoc(stateFilePath: string, state: JobState): string {
  return [
    "# State Schema (Pre-RSS Migration)",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Source file: \`${stateFilePath}\``,
    "",
    "## TypeScript contract",
    "```ts",
    "type JobState = {",
    "  lastSeenJobId: string | null;",
    "};",
    "```",
    "",
    "## Field semantics",
    "- `lastSeenJobId`: Cursor for the newest listing processed in the legacy crawl pipeline.",
    "",
    "## Snapshot before baseline run",
    "```json",
    JSON.stringify(state, null, 2),
    "```",
    "",
  ].join("\n");
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function parseArgs(argv: string[]): Required<Phase0Options> {
  let stateFilePath = "state.json";
  let metricsPath = DEFAULT_BASELINE_METRICS_PATH;
  let backupDir = DEFAULT_STATE_BACKUP_DIR;
  let schemaPath = DEFAULT_STATE_SCHEMA_PATH;

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

    if (arg === "--metrics-path" && argv[i + 1]) {
      metricsPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--metrics-path=")) {
      metricsPath = arg.slice("--metrics-path=".length);
      continue;
    }

    if (arg === "--backup-dir" && argv[i + 1]) {
      backupDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--backup-dir=")) {
      backupDir = arg.slice("--backup-dir=".length);
      continue;
    }

    if (arg === "--schema-path" && argv[i + 1]) {
      schemaPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--schema-path=")) {
      schemaPath = arg.slice("--schema-path=".length);
      continue;
    }

    throw new Error(`Unsupported argument: ${arg}`);
  }

  return {
    stateFilePath,
    metricsPath,
    backupDir,
    schemaPath,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifacts = await runPhase0(options);

  console.log(`State backup created: ${path.resolve(artifacts.stateBackupPath)}`);
  console.log(`State schema doc written: ${path.resolve(artifacts.stateSchemaPath)}`);
  console.log(`Baseline metrics written: ${path.resolve(artifacts.baselineMetricsPath)}`);
  console.log(`Baseline summary: ${JSON.stringify(artifacts.runSummary)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
