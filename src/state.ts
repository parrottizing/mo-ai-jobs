import { promises as fs } from "fs";

export type JobState = {
  schemaVersion: 1;
  lastSeenJobId: string | null;
  latestSeenPubDate: string | null;
  seenIds: string[];
  notifiedIds: string[];
};

export const STATE_SCHEMA_VERSION = 1;
export const MAX_SEEN_IDS = 5_000;
export const MAX_NOTIFIED_IDS = 5_000;

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

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  };
}

async function writeState(path: string, state: JobState): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(path, `${payload}\n`, "utf-8");
}
