import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { runOnceWithSummary, type RunSummary } from "./index";

const execFileAsync = promisify(execFile);

const DEFAULT_PHASE9_DIR = "migration/phase9";
const DEFAULT_REPORT_PATH = path.join(DEFAULT_PHASE9_DIR, "rollout-report.json");
const DEFAULT_DIST_DIR = "dist";
const DEFAULT_DIST_BACKUP_DIR = path.join(DEFAULT_PHASE9_DIR, "dist-backups");
const DEFAULT_STATE_FILE_PATH = "state.json";
const DEFAULT_MONITORED_RUNS = 3;

type Phase9Options = {
  stateFilePath?: string;
  reportPath?: string;
  distDir?: string;
  distBackupDir?: string;
  monitoredRuns?: number;
  skipBuild?: boolean;
};

type CommandResult = {
  command: string;
  success: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
};

type RunObservation = {
  runNumber: number;
  summary: RunSummary;
  duplicateSentJobIds: string[];
};

type Phase9Report = {
  generatedAt: string;
  artifacts: {
    reportPath: string;
    stateFilePath: string;
    distDir: string;
    distBackupPath: string | null;
  };
  build: CommandResult | null;
  monitoredRuns: number;
  runResults: RunObservation[];
  findings: {
    duplicateSentJobIds: string[];
    runsWithDuplicateAlerts: number[];
    runsWithEnrichmentFailures: number[];
    runsWithTelegramFailures: number[];
  };
  checks: {
    no_duplicate_alerts: boolean;
    no_enrichment_failures: boolean;
    no_telegram_failures: boolean;
  };
  allChecksPassed: boolean;
};

export async function runPhase9(options: Phase9Options = {}): Promise<{ reportPath: string; report: Phase9Report }> {
  const stateFilePath = options.stateFilePath ?? DEFAULT_STATE_FILE_PATH;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const distBackupDir = options.distBackupDir ?? DEFAULT_DIST_BACKUP_DIR;
  const monitoredRuns = normalizePositiveInteger(options.monitoredRuns, DEFAULT_MONITORED_RUNS);
  const skipBuild = options.skipBuild ?? false;

  const distBackupPath = await backupDistArtifacts(distDir, distBackupDir);

  let build: CommandResult | null = null;
  if (!skipBuild) {
    build = await runCommand("npx", ["tsc"]);
    assertCommandSucceeded(build);
  }

  const seenSentJobIds = new Set<string>();
  const duplicateSentJobIds = new Set<string>();
  const runsWithDuplicateAlerts: number[] = [];
  const runsWithEnrichmentFailures: number[] = [];
  const runsWithTelegramFailures: number[] = [];
  const runResults: RunObservation[] = [];

  for (let runNumber = 1; runNumber <= monitoredRuns; runNumber += 1) {
    const summary = await runOnceWithSummary({ stateFilePath });
    const duplicateIdsInRun = summary.sentJobIds.filter((jobId) => {
      if (seenSentJobIds.has(jobId)) {
        duplicateSentJobIds.add(jobId);
        return true;
      }
      seenSentJobIds.add(jobId);
      return false;
    });

    if (duplicateIdsInRun.length > 0) {
      runsWithDuplicateAlerts.push(runNumber);
    }

    if (summary.counters.enrichment_failures_total > 0) {
      runsWithEnrichmentFailures.push(runNumber);
    }

    if (summary.telegramFailedCount > 0) {
      runsWithTelegramFailures.push(runNumber);
    }

    runResults.push({
      runNumber,
      summary,
      duplicateSentJobIds: duplicateIdsInRun,
    });
  }

  const checks = {
    no_duplicate_alerts: runsWithDuplicateAlerts.length === 0,
    no_enrichment_failures: runsWithEnrichmentFailures.length === 0,
    no_telegram_failures: runsWithTelegramFailures.length === 0,
  };

  const report: Phase9Report = {
    generatedAt: new Date().toISOString(),
    artifacts: {
      reportPath,
      stateFilePath,
      distDir,
      distBackupPath,
    },
    build,
    monitoredRuns,
    runResults,
    findings: {
      duplicateSentJobIds: Array.from(duplicateSentJobIds),
      runsWithDuplicateAlerts,
      runsWithEnrichmentFailures,
      runsWithTelegramFailures,
    },
    checks,
    allChecksPassed:
      checks.no_duplicate_alerts &&
      checks.no_enrichment_failures &&
      checks.no_telegram_failures,
  };

  await writeJsonFile(reportPath, report);

  return {
    reportPath,
    report,
  };
}

async function backupDistArtifacts(distDir: string, backupDir: string): Promise<string | null> {
  if (!(await pathExists(distDir))) {
    return null;
  }

  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `dist-backup-${timestamp}`);
  await fs.cp(distDir, backupPath, { recursive: true });
  return backupPath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
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

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }

  return value;
}

function parseArgs(argv: string[]): Required<Phase9Options> {
  let stateFilePath = DEFAULT_STATE_FILE_PATH;
  let reportPath = DEFAULT_REPORT_PATH;
  let distDir = DEFAULT_DIST_DIR;
  let distBackupDir = DEFAULT_DIST_BACKUP_DIR;
  let monitoredRuns = DEFAULT_MONITORED_RUNS;
  let skipBuild = false;

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

    if (arg === "--dist-dir" && argv[i + 1]) {
      distDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--dist-dir=")) {
      distDir = arg.slice("--dist-dir=".length);
      continue;
    }

    if (arg === "--backup-dir" && argv[i + 1]) {
      distBackupDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--backup-dir=")) {
      distBackupDir = arg.slice("--backup-dir=".length);
      continue;
    }

    if (arg === "--runs" && argv[i + 1]) {
      monitoredRuns = parsePositiveIntegerArg("--runs", argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith("--runs=")) {
      monitoredRuns = parsePositiveIntegerArg("--runs", arg.slice("--runs=".length));
      continue;
    }

    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }

    throw new Error(`Unsupported argument: ${arg}`);
  }

  return {
    stateFilePath,
    reportPath,
    distDir,
    distBackupDir,
    monitoredRuns,
    skipBuild,
  };
}

function parsePositiveIntegerArg(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${flag}: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { reportPath, report } = await runPhase9(options);

  console.log(`Phase 9 rollout report written: ${path.resolve(reportPath)}`);
  console.log(`Monitored runs: ${report.monitoredRuns}`);
  console.log(`No duplicate alerts: ${report.checks.no_duplicate_alerts}`);
  console.log(`No enrichment failures: ${report.checks.no_enrichment_failures}`);
  console.log(`No Telegram failures: ${report.checks.no_telegram_failures}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
