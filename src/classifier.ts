import type { FeedJob } from "./rss-models";

export type ClassifierJob = Pick<
  FeedJob,
  "id" | "title" | "detailUrl" | "company" | "location" | "tags" | "descriptionText"
>;

export type JobClassificationDecision = {
  model: string;
  decidedAt: string;
  promptTokens: number;
  descriptionChars: number;
  descriptionCharsUsed: number;
  descriptionWasClipped: boolean;
};

export type JobMatchResult = {
  job: ClassifierJob;
  match: boolean;
  rationale: string;
  rawResponse: string;
  decision: JobClassificationDecision;
};

export type ClassifyOptions = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  descriptionCharCap?: number;
  rateLimit?: {
    tokensPerMinute?: number;
    safetyMargin?: number;
    minDelayMs?: number;
  };
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_MODEL = "gemma-3-27b-it";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DESCRIPTION_CHAR_CAP = 4_000;

type PromptInput = {
  description: string;
  tagsLine: string;
  descriptionChars: number;
  descriptionCharsUsed: number;
  descriptionWasClipped: boolean;
};

export async function classifyJobs(
  jobs: ClassifierJob[],
  options: ClassifyOptions,
): Promise<JobMatchResult[]> {
  const results: JobMatchResult[] = [];
  const limiter = createRateLimiter(options.rateLimit);

  for (const job of jobs) {
    const promptInput = preparePromptInput(job, options.descriptionCharCap);
    const prompt = buildPrompt(job, promptInput);
    const promptTokens = estimateTokens(prompt);
    await limiter.consume(promptTokens);
    results.push(await classifyJobWithPrompt(job, promptInput, prompt, promptTokens, options));
  }

  return results;
}

export async function classifyJob(
  job: ClassifierJob,
  options: ClassifyOptions,
): Promise<JobMatchResult> {
  const promptInput = preparePromptInput(job, options.descriptionCharCap);
  const prompt = buildPrompt(job, promptInput);
  const promptTokens = estimateTokens(prompt);
  return classifyJobWithPrompt(job, promptInput, prompt, promptTokens, options);
}

function buildPrompt(job: ClassifierJob, promptInput: PromptInput): string {
  return [
    "You are evaluating if a candidate is qualified for a job posting.",
    "",
    "CANDIDATE PROFILE:",
    "- 3.5 years of deep AI experience, using approximately 200 different AI services.",
    "- Experienced 'vibecoder' who builds automation and code projects exclusively using AI agents.",
    "- Proficient with AI coding tools: Cursor, Claude Code, various IDE and CLI AI agents.",
    "- Strong understanding of context engineering and prompt engineering.",
    "- KEY CONSTRAINT: Not a traditional developer. Cannot write code without AI assistance.",
    "- Qualified for roles that embrace AI-driven development and don't strictly require manual coding interviews or deep syntax knowledge.",
    "",
    "JOB POSTING:",
    `Title: ${job.title}`,
    `Company: ${job.company ?? "Unknown"}`,
    `Location: ${job.location ?? "Unknown"}`,
    `Tags: ${promptInput.tagsLine}`,
    `Description: ${promptInput.description}`,
    "",
    "Question: Is this candidate qualified for this job?",
    "Answer with one word only: YES or NO.",
  ].join("\n");
}

async function classifyJobWithPrompt(
  job: ClassifierJob,
  promptInput: PromptInput,
  prompt: string,
  promptTokens: number,
  options: ClassifyOptions,
): Promise<JobMatchResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const responseText = await callGemini(prompt, model, options);
  const parsed = parseClassification(responseText);

  if (!parsed) {
    throw new Error("Failed to parse classification response from Gemini API.");
  }

  return {
    job,
    match: parsed.match,
    rationale: parsed.rationale,
    rawResponse: responseText,
    decision: {
      model,
      decidedAt: new Date().toISOString(),
      promptTokens,
      descriptionChars: promptInput.descriptionChars,
      descriptionCharsUsed: promptInput.descriptionCharsUsed,
      descriptionWasClipped: promptInput.descriptionWasClipped,
    },
  };
}

function preparePromptInput(job: ClassifierJob, descriptionCharCap?: number): PromptInput {
  const normalizedDescription = normalizePromptText(job.descriptionText);
  const descriptionChars = normalizedDescription.length;
  const clippedDescription = clipText(
    normalizedDescription,
    descriptionCharCap ?? DEFAULT_DESCRIPTION_CHAR_CAP,
  );
  const tagsLine = normalizeTags(job.tags);

  return {
    description: clippedDescription.text || "No description provided.",
    tagsLine,
    descriptionChars,
    descriptionCharsUsed: clippedDescription.text.length,
    descriptionWasClipped: clippedDescription.wasClipped,
  };
}

function normalizeTags(tags: string[]): string {
  const unique = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = normalizePromptText(tag);
    if (!value || unique.has(value)) {
      continue;
    }
    unique.add(value);
    normalized.push(value);
  }

  return normalized.length > 0 ? normalized.join(", ") : "None";
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(text: string, requestedCap: number): { text: string; wasClipped: boolean } {
  const cap = Math.max(1, Math.floor(requestedCap));
  if (text.length <= cap) {
    return { text, wasClipped: false };
  }

  const suffix = "... [truncated]";
  if (cap <= suffix.length) {
    return {
      text: text.slice(0, cap),
      wasClipped: true,
    };
  }

  const sliceLength = Math.max(0, cap - suffix.length);
  const clipped = text.slice(0, sliceLength).trimEnd();
  return {
    text: `${clipped}${suffix}`,
    wasClipped: true,
  };
}

async function callGemini(prompt: string, model: string, options: ClassifyOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${options.apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens: 200,
    },
  };

  const maxRetries = 5;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await safeReadBody(response);
        if (response.status === 429 && attempt < maxRetries) {
          const retryDelayMs = parseRetryDelayMs(errorBody) ?? 30_000;
          await sleep(retryDelayMs);
          continue;
        }
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} ${errorBody}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const text = extractGeminiText(data);
      if (!text) {
        throw new Error("Gemini API returned empty response text.");
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Gemini API error: exceeded retry attempts.");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

function createRateLimiter(options?: ClassifyOptions["rateLimit"]) {
  const tokensPerMinute = options?.tokensPerMinute ?? 15000;
  const safetyMargin = options?.safetyMargin ?? 0.6;
  const minDelayMs = options?.minDelayMs ?? 0;
  const effectiveLimit = Math.max(1, Math.floor(tokensPerMinute * safetyMargin));

  let windowStart = Date.now();
  let tokensUsed = 0;
  let lastCallAt = 0;

  const resetWindow = (now: number) => {
    windowStart = now;
    tokensUsed = 0;
  };

  return {
    async consume(tokensNeeded: number): Promise<void> {
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        resetWindow(now);
      }

      const requiredIntervalMs = Math.ceil((tokensNeeded / effectiveLimit) * 60_000);
      if (requiredIntervalMs > 0 && lastCallAt > 0) {
        const sinceLast = now - lastCallAt;
        if (sinceLast < requiredIntervalMs) {
          await sleep(requiredIntervalMs - sinceLast);
        }
      }

      if (tokensUsed + tokensNeeded > effectiveLimit) {
        const waitMs = Math.max(0, windowStart + 60_000 - now);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        resetWindow(Date.now());
      }

      if (minDelayMs > 0 && lastCallAt > 0) {
        const sinceLast = Date.now() - lastCallAt;
        if (sinceLast < minDelayMs) {
          await sleep(minDelayMs - sinceLast);
        }
      }

      tokensUsed += tokensNeeded;
      lastCallAt = Date.now();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(errorBody: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/i.exec(errorBody);
  if (!match?.[1]) {
    return null;
  }
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return Math.max(0, Math.ceil(seconds * 1000));
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function extractGeminiText(data: GeminiResponse): string | null {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const combined = parts
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
    .trim();
  return combined || null;
}

function parseClassification(text: string): { match: boolean; rationale: string } | null {
  const normalized = text.trim().toUpperCase();

  if (normalized.startsWith("YES")) {
    return { match: true, rationale: "Qualified based on AI-native profile." };
  }

  if (normalized.startsWith("NO")) {
    return { match: false, rationale: "Not qualified for this role." };
  }

  return null;
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<
        | {
          text?: string;
        }
        | Record<string, unknown>
      >;
    };
  }>;
};
