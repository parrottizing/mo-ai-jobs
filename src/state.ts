import { promises as fs } from "fs";

export type JobState = {
  schemaVersion: 2;
  lastSeenJobId: string | null;
  latestSeenPubDate: string | null;
  seenIds: string[];
  notifiedIds: string[];
  classificationDecisions: ClassificationDecisionRecord[];
};

export type ClassificationDecisionRecord = {
  jobId: string;
  match: boolean;
  rationale: string;
  rawResponse: string;
  decidedAt: string;
  model: string;
  promptTokens: number;
  descriptionChars: number;
  descriptionCharsUsed: number;
  descriptionWasClipped: boolean;
};

export const STATE_SCHEMA_VERSION = 2;
export const MAX_SEEN_IDS = 5_000;
export const MAX_NOTIFIED_IDS = 5_000;
export const MAX_CLASSIFICATION_DECISIONS = 5_000;
const DEFAULT_DECIDED_AT = "1970-01-01T00:00:00.000Z";

const DEFAULT_STATE: JobState = createDefaultState();

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadState(path: string): Promise<JobState> {
  if (!(await fileExists(path))) {
    const defaultState = createDefaultState();
    await saveState(path, defaultState);
    return defaultState;
  }

  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const state = normalizeState(parsed);

    if (stateNeedsRewrite(parsed, state)) {
      await writeState(path, state);
    }

    return state;
  } catch {
    const defaultState = createDefaultState();
    await saveState(path, defaultState);
    return defaultState;
  }
}

export async function saveState(path: string, state: JobState): Promise<void> {
  await writeState(path, normalizeState(state));
}

type StateLikeRecord = Record<string, unknown>;

function normalizeState(input: unknown): JobState {
  const parsed = isRecord(input) ? input : {};

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastSeenJobId: readNullableString(parsed.lastSeenJobId),
    latestSeenPubDate: readNullableString(parsed.latestSeenPubDate),
    seenIds: normalizeIds(parsed.seenIds, MAX_SEEN_IDS),
    notifiedIds: normalizeIds(parsed.notifiedIds, MAX_NOTIFIED_IDS),
    classificationDecisions: normalizeClassificationDecisions(
      parsed.classificationDecisions,
      MAX_CLASSIFICATION_DECISIONS,
    ),
  };
}

function stateNeedsRewrite(raw: unknown, normalized: JobState): boolean {
  if (!isRecord(raw)) {
    return true;
  }

  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    return true;
  }

  if (raw.lastSeenJobId !== normalized.lastSeenJobId) {
    return true;
  }

  if (raw.latestSeenPubDate !== normalized.latestSeenPubDate) {
    return true;
  }

  if (!stringArrayEquals(raw.seenIds, normalized.seenIds)) {
    return true;
  }

  if (!stringArrayEquals(raw.notifiedIds, normalized.notifiedIds)) {
    return true;
  }

  if (!classificationDecisionsEqual(raw.classificationDecisions, normalized.classificationDecisions)) {
    return true;
  }

  return false;
}

function stringArrayEquals(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i += 1) {
    if (value[i] !== expected[i]) {
      return false;
    }
  }

  return true;
}

function classificationDecisionsEqual(
  value: unknown,
  expected: ClassificationDecisionRecord[],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) {
    return false;
  }

  for (let i = 0; i < expected.length; i += 1) {
    const actual = value[i];
    const target = expected[i];
    if (!isRecord(actual)) {
      return false;
    }
    if (actual.jobId !== target.jobId) {
      return false;
    }
    if (actual.match !== target.match) {
      return false;
    }
    if (actual.rationale !== target.rationale) {
      return false;
    }
    if (actual.rawResponse !== target.rawResponse) {
      return false;
    }
    if (actual.decidedAt !== target.decidedAt) {
      return false;
    }
    if (actual.model !== target.model) {
      return false;
    }
    if (actual.promptTokens !== target.promptTokens) {
      return false;
    }
    if (actual.descriptionChars !== target.descriptionChars) {
      return false;
    }
    if (actual.descriptionCharsUsed !== target.descriptionCharsUsed) {
      return false;
    }
    if (actual.descriptionWasClipped !== target.descriptionWasClipped) {
      return false;
    }
  }

  return true;
}

function normalizeIds(value: unknown, maxSize: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const normalizedId = item.trim();
    if (!normalizedId || seen.has(normalizedId)) {
      continue;
    }

    seen.add(normalizedId);
    normalized.push(normalizedId);
  }

  if (normalized.length <= maxSize) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxSize);
}

function normalizeClassificationDecisions(
  value: unknown,
  maxSize: number,
): ClassificationDecisionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const dedupedByJobId = new Map<string, ClassificationDecisionRecord>();

  for (const item of value) {
    const normalized = normalizeClassificationDecision(item);
    if (!normalized) {
      continue;
    }

    if (dedupedByJobId.has(normalized.jobId)) {
      dedupedByJobId.delete(normalized.jobId);
    }
    dedupedByJobId.set(normalized.jobId, normalized);
  }

  const normalized = Array.from(dedupedByJobId.values());
  if (normalized.length <= maxSize) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxSize);
}

function normalizeClassificationDecision(value: unknown): ClassificationDecisionRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const jobId = readNullableString(value.jobId);
  if (!jobId) {
    return null;
  }

  const decidedAt = readNullableIsoTimestamp(value.decidedAt) ?? DEFAULT_DECIDED_AT;

  return {
    jobId,
    match: readBoolean(value.match),
    rationale: readString(value.rationale),
    rawResponse: readString(value.rawResponse),
    decidedAt,
    model: readString(value.model),
    promptTokens: readNonNegativeInteger(value.promptTokens),
    descriptionChars: readNonNegativeInteger(value.descriptionChars),
    descriptionCharsUsed: readNonNegativeInteger(value.descriptionCharsUsed),
    descriptionWasClipped: readBoolean(value.descriptionWasClipped),
  };
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

function readNullableIsoTimestamp(value: unknown): string | null {
  const normalized = readNullableString(value);
  if (!normalized) {
    return null;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is StateLikeRecord {
  return typeof value === "object" && value !== null;
}

function createDefaultState(): JobState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastSeenJobId: null,
    latestSeenPubDate: null,
    seenIds: [],
    notifiedIds: [],
    classificationDecisions: [],
  };
}

async function writeState(path: string, state: JobState): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(path, `${payload}\n`, "utf-8");
}
