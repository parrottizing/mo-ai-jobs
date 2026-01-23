import { promises as fs } from "fs";

export type JobState = {
  lastSeenJobId: string | null;
};

const DEFAULT_STATE: JobState = {
  lastSeenJobId: null,
};

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
    await saveState(path, DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<JobState>;
    return {
      lastSeenJobId: typeof parsed.lastSeenJobId === "string" ? parsed.lastSeenJobId : null,
    };
  } catch {
    await saveState(path, DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(path: string, state: JobState): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(path, `${payload}\n`, "utf-8");
}
