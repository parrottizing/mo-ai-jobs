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
    requestsPerMinute?: number;
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
    "You are a strict hiring screener. Minimize false positives.",
    "If uncertain, answer NO.",
    "",
    "CANDIDATE PROFILE:",
    "- 3.5 years of deep AI experience, using approximately 200 different AI services.",
    "- Experienced 'vibecoder' who builds automation and code projects exclusively using AI agents.",
    "- Proficient with AI coding tools: Cursor, Claude Code, various IDE and CLI AI agents.",
    "- Strong understanding of context engineering and prompt engineering.",
    "- KEY CONSTRAINT: Not a traditional developer. Cannot write code without AI assistance.",
    "- Qualified for roles that embrace AI-driven development and don't strictly require independent manual coding ability.",
    "",
    "USER PREFERENCES:",
    "- Reject expired or closed job postings.",
    "",
    "JOB POSTING:",
    `Title: ${job.title}`,
    `Company: ${job.company ?? "Unknown"}`,
    `Location: ${job.location ?? "Unknown"}`,
    `Tags: ${promptInput.tagsLine}`,
    `Description: ${promptInput.description}`,
    "",
    "HARD-FAIL RULES (any one => NO):",
    "1) Mandatory credential, license, or degree missing from the profile (e.g., JD, bar, MD, PE).",
    "2) Role requires independent manual coding ability without AI assistance.",
    "3) Core domain mismatch requiring specialized background not shown in the profile.",
    "4) Posting is expired or closed.",
    "",
    "YES RULE:",
    "- Return YES only if no hard-fail rule is triggered and the role is clearly AI-native and compatible with AI-assisted delivery.",
    "",
    "OUTPUT FORMAT (exactly 3 lines):",
    "Line 1: YES or NO",
    "Line 2: REASON_CODES: <comma-separated from: GOOD_AI_NATIVE_FIT, MISSING_REQUIRED_CREDENTIAL, MANUAL_CODING_REQUIRED, DOMAIN_MISMATCH, EXPIRED_OR_CLOSED, INSUFFICIENT_EVIDENCE>",
    "Line 3: EVIDENCE: <up to two short snippets from the job text>",
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
  const requestsPerMinute = options?.requestsPerMinute ?? 30;
  const tokensPerMinute = options?.tokensPerMinute ?? 15000;
  const safetyMargin = options?.safetyMargin ?? 1;
  const minDelayMs = options?.minDelayMs ?? 0;
  const effectiveRequestLimit = Math.max(1, Math.floor(requestsPerMinute * safetyMargin));
  const effectiveTokenLimit = Math.max(1, Math.floor(tokensPerMinute * safetyMargin));

  let windowStart = Date.now();
  let requestsUsed = 0;
  let tokensUsed = 0;
  let lastCallAt = 0;

  const resetWindow = (now: number) => {
    windowStart = now;
    requestsUsed = 0;
    tokensUsed = 0;
  };

  return {
    async consume(tokensNeeded: number): Promise<void> {
      const normalizedTokens = Math.max(1, Math.floor(tokensNeeded));
      const requestIntervalMs = Math.ceil(60_000 / effectiveRequestLimit);

      while (true) {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          resetWindow(now);
        }

        let waitMs = 0;
        const tokensForWindowCheck = Math.min(normalizedTokens, effectiveTokenLimit);

        if (requestsUsed + 1 > effectiveRequestLimit || tokensUsed + tokensForWindowCheck > effectiveTokenLimit) {
          waitMs = Math.max(waitMs, Math.max(0, windowStart + 60_000 - now));
        }

        if (lastCallAt > 0) {
          const sinceLast = now - lastCallAt;
          if (sinceLast < requestIntervalMs) {
            waitMs = Math.max(waitMs, requestIntervalMs - sinceLast);
          }

          const tokenIntervalMs = Math.ceil((tokensForWindowCheck / effectiveTokenLimit) * 60_000);
          if (sinceLast < tokenIntervalMs) {
            waitMs = Math.max(waitMs, tokenIntervalMs - sinceLast);
          }

          if (minDelayMs > 0 && sinceLast < minDelayMs) {
            waitMs = Math.max(waitMs, minDelayMs - sinceLast);
          }
        }

        if (waitMs > 0) {
          await sleep(waitMs);
          continue;
        }

        requestsUsed += 1;
        tokensUsed += tokensForWindowCheck;
        lastCallAt = Date.now();
        return;
      }
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
  const normalized = text.trim();
  const verdictMatch = /^\s*(YES|NO)\b/i.exec(normalized);
  if (!verdictMatch) {
    return null;
  }

  const match = verdictMatch[1].toUpperCase() === "YES";
  const reasonCodes = parseReasonCodes(normalized);
  const evidence = parseEvidence(normalized);

  if (reasonCodes.length === 0 && !evidence) {
    return {
      match,
      rationale: match ? "Qualified based on AI-native profile." : "Not qualified for this role.",
    };
  }

  const defaultCode = match ? "GOOD_AI_NATIVE_FIT" : "INSUFFICIENT_EVIDENCE";
  const codes = reasonCodes.length > 0 ? reasonCodes : [defaultCode];
  const rationale = [
    `Reason codes: ${codes.join(", ")}`,
    evidence ? `Evidence: ${evidence}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return { match, rationale };
}

function parseReasonCodes(text: string): string[] {
  const line = findTaggedLineValue(text, "REASON_CODES");
  if (!line) {
    return [];
  }

  const allowed = new Set([
    "GOOD_AI_NATIVE_FIT",
    "MISSING_REQUIRED_CREDENTIAL",
    "MANUAL_CODING_REQUIRED",
    "DOMAIN_MISMATCH",
    "EXPIRED_OR_CLOSED",
    "INSUFFICIENT_EVIDENCE",
  ]);

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const token of line.split(",")) {
    const value = token
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_ ]+/g, "")
      .replace(/\s+/g, "_");

    if (!value || seen.has(value) || !allowed.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function parseEvidence(text: string): string | null {
  const line = findTaggedLineValue(text, "EVIDENCE");
  if (!line) {
    return null;
  }

  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const maxLength = 220;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function findTaggedLineValue(text: string, tag: string): string | null {
  const escapedTag = escapeRegExp(tag);
  const regex = new RegExp(`^\\s*${escapedTag}\\s*:\\s*(.+)$`, "im");
  const match = regex.exec(text);
  return match?.[1]?.trim() ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
