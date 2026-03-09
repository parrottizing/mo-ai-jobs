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
  continueOnError?: boolean;
  onJobError?: (context: { job: ClassifierJob; error: unknown }) => void;
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

    try {
      await limiter.consume(promptTokens);
      results.push(await classifyJobWithPrompt(job, promptInput, prompt, promptTokens, options));
    } catch (error) {
      if (!options.continueOnError) {
        throw error;
      }
      options.onJobError?.({ job, error });
      results.push(buildFallbackNoMatchResult(job, promptInput, promptTokens, options.model, error));
    }
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
    "If any mandatory requirement is not clearly met, return NO.",
    "Do not assume transferable experience is acceptable unless the job explicitly says so.",
    "",
    "CANDIDATE PROFILE:",
    "- Relevant AI-focused experience: ~3.5 years (including AI-assisted freelancing, automation, and prototyping work).",
    "- Additional earlier work history in sales and sales-adjacent operations/administrative support (cold outreach, lead sourcing, process improvement).",
    "- Deep practical AI usage across many tools, strong in prompt/context engineering, AI-assisted automation, and rapid prototyping.",
    "- Builds software only with AI assistance; cannot do independent manual coding without AI.",
    "- No proven long-term professional track record in: product/program management (PM/TPM), content strategy/marketing/editorial, demand generation/growth marketing, communications/PR leadership, management consulting/customer success/solutions architecture, product design leadership, executive creative/production leadership, QA/quality engineering leadership, people leadership, applied ML research, or advanced data science.",
    "- No explicit evidence of an advanced degree (MS/PhD).",
    "",
    "USER PREFERENCES:",
    "- Reject expired or closed job postings.",
    "- Prioritize precision over recall: better to miss a borderline fit than send an obvious mismatch.",
    "",
    "JOB POSTING:",
    `Title: ${job.title}`,
    `Company: ${job.company ?? "Unknown"}`,
    `Location: ${job.location ?? "Unknown"}`,
    `Tags: ${promptInput.tagsLine}`,
    `Description: ${promptInput.description}`,
    "",
    "MANDATORY EVALUATION ORDER:",
    "1) Read mandatory sections first: 'Required', 'Minimum', 'Basic Qualifications', 'Must have', title seniority, and mandatory location/work authorization.",
    "2) Ignore preferred/nice-to-have sections for eligibility unless they are explicitly mandatory.",
    "3) Check mandatory years and function track record before any AI-related fit signals.",
    "4) If any mandatory item is missing from the profile, return NO.",
    "5) If evidence is ambiguous, return NO.",
    "",
    "HARD-FAIL RULES (any one => NO):",
    "1) Mandatory relevant experience exceeds profile evidence for that function, or requires years in a function not in profile.",
    "2) Seniority mismatch: title/requirements demand Senior/Staff/Principal/Lead/Manager/Director/Head/VP-level ownership not shown in profile.",
    "3) Functional background mismatch: role requires proven PM/TPM ownership, demand generation/growth marketing, communications/PR leadership, consulting/customer success/solutions, design leadership, executive production leadership, QA/quality engineering leadership, ML research, or deep data-science background.",
    "4) Mandatory credential/degree missing from profile, including explicit MS/PhD requirements.",
    "5) Role requires independent manual coding ability without AI assistance.",
    "6) Mandatory location, work authorization, or hybrid/on-site presence requirement is not met.",
    "7) Posting is expired or closed.",
    "",
    "YES RULE:",
    "- Return YES only when every mandatory requirement is satisfied and no hard-fail rule is triggered.",
    "- AI-native language alone is never enough for YES and cannot replace missing role-family track record.",
    "",
    "OUTPUT FORMAT (exactly 3 lines):",
    "Line 1: YES or NO",
    "Line 2: REASON_CODES: <comma-separated from: GOOD_AI_NATIVE_FIT, MISSING_REQUIRED_EXPERIENCE, SENIORITY_MISMATCH, FUNCTIONAL_BACKGROUND_MISMATCH, MISSING_REQUIRED_CREDENTIAL, ADVANCED_DEGREE_REQUIRED, MANUAL_CODING_REQUIRED, LOCATION_OR_WORK_AUTH_MISMATCH, DOMAIN_MISMATCH, EXPIRED_OR_CLOSED, INSUFFICIENT_EVIDENCE>",
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
    const preview = responseText.replace(/\s+/g, " ").slice(0, 220);
    throw new Error(`Failed to parse classification response from Gemini API. Response preview: ${preview}`);
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
        if (attempt < maxRetries && isRetryableGeminiStatus(response.status)) {
          const retryDelayMs =
            parseRetryAfterHeaderMs(response.headers.get("retry-after")) ??
            parseRetryDelayMs(errorBody) ??
            getApiRetryDelayMs(attempt, response.status);
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
    } catch (error) {
      if (attempt < maxRetries && isRetryableGeminiError(error)) {
        await sleep(getTransientRetryDelayMs(attempt));
        continue;
      }
      throw error;
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

function parseRetryAfterHeaderMs(retryAfter: string | null): number | null {
  if (!retryAfter) {
    return null;
  }

  const numericSeconds = Number(retryAfter.trim());
  if (Number.isFinite(numericSeconds)) {
    return Math.max(0, Math.ceil(numericSeconds * 1000));
  }

  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, timestamp - Date.now());
}

function isRetryableGeminiStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getApiRetryDelayMs(attempt: number, status: number): number {
  if (status === 429 || status === 503) {
    const baseMs = 10_000;
    const delayMs = baseMs * 2 ** attempt;
    return Math.min(120_000, delayMs);
  }

  const baseMs = 2_000;
  const delayMs = baseMs * 2 ** attempt;
  return Math.min(30_000, delayMs);
}

function getTransientRetryDelayMs(attempt: number): number {
  const baseMs = 1_000;
  const delayMs = baseMs * 2 ** attempt;
  return Math.min(15_000, delayMs);
}

function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes("abort") || message.includes("timed out") || message.includes("timeout")) {
    return true;
  }
  if (message.includes("fetch failed") || message.includes("network")) {
    return true;
  }

  return false;
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
  const normalized = normalizeModelOutput(text);
  const match = extractVerdict(normalized);
  if (match === null) {
    return null;
  }

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

function normalizeModelOutput(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/```(?:[\w-]+)?/g, "")
    .trim();
}

function extractVerdict(text: string): boolean | null {
  const explicitLineOne = findTaggedLineValue(text, "Line 1");
  const explicitLineOneVerdict = parseVerdictToken(explicitLineOne);
  if (explicitLineOneVerdict !== null) {
    return explicitLineOneVerdict;
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines.slice(0, 10)) {
    const verdict = parseVerdictToken(line);
    if (verdict !== null) {
      return verdict;
    }
  }

  return null;
}

function parseVerdictToken(input: string | null | undefined): boolean | null {
  if (!input) {
    return null;
  }

  const normalized = input
    .trim()
    .replace(/^[-*#>\s]+/, "")
    .replace(/^\d+[.)]\s*/, "");

  const directMatch = /^(YES|NO)\b/i.exec(normalized);
  if (directMatch) {
    return directMatch[1].toUpperCase() === "YES";
  }

  const taggedMatch = /^(?:LINE\s*1|VERDICT|ANSWER|FINAL\s+ANSWER)\s*[:\-]\s*(YES|NO)\b/i.exec(normalized);
  if (taggedMatch) {
    return taggedMatch[1].toUpperCase() === "YES";
  }

  return null;
}

function buildFallbackNoMatchResult(
  job: ClassifierJob,
  promptInput: PromptInput,
  promptTokens: number,
  model: string | undefined,
  error: unknown,
): JobMatchResult {
  const reason = formatError(error).replace(/\s+/g, " ").trim();
  const evidence = clipReason(reason, 220);

  return {
    job,
    match: false,
    rationale: `Reason codes: INSUFFICIENT_EVIDENCE Evidence: ${evidence}`,
    rawResponse: `[classifier_error] ${reason}`,
    decision: {
      model: model ?? DEFAULT_MODEL,
      decidedAt: new Date().toISOString(),
      promptTokens,
      descriptionChars: promptInput.descriptionChars,
      descriptionCharsUsed: promptInput.descriptionCharsUsed,
      descriptionWasClipped: promptInput.descriptionWasClipped,
    },
  };
}

function clipReason(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function parseReasonCodes(text: string): string[] {
  const line = findTaggedLineValue(text, "REASON_CODES");
  if (!line) {
    return [];
  }

  const allowed = new Set([
    "GOOD_AI_NATIVE_FIT",
    "MISSING_REQUIRED_EXPERIENCE",
    "SENIORITY_MISMATCH",
    "FUNCTIONAL_BACKGROUND_MISMATCH",
    "MISSING_REQUIRED_CREDENTIAL",
    "ADVANCED_DEGREE_REQUIRED",
    "MANUAL_CODING_REQUIRED",
    "LOCATION_OR_WORK_AUTH_MISMATCH",
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
  const regex = new RegExp(`^\\s*(?:LINE\\s*\\d+\\s*:\\s*)?${escapedTag}\\s*:\\s*(.+)$`, "im");
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
