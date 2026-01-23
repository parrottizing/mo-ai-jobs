import type { JobDetails } from "./details";

export type JobMatchResult = {
  job: JobDetails;
  match: boolean;
  rationale: string;
  rawResponse: string;
};

export type ClassifyOptions = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_MODEL = "gemma-3-27b-it";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function classifyJobs(
  jobs: JobDetails[],
  options: ClassifyOptions,
): Promise<JobMatchResult[]> {
  const results: JobMatchResult[] = [];
  for (const job of jobs) {
    results.push(await classifyJob(job, options));
  }
  return results;
}

export async function classifyJob(
  job: JobDetails,
  options: ClassifyOptions,
): Promise<JobMatchResult> {
  const prompt = buildPrompt(job);
  const responseText = await callGemini(prompt, options);
  const parsed = parseClassification(responseText);

  if (!parsed) {
    throw new Error("Failed to parse classification response from Gemini API.");
  }

  return {
    job,
    match: parsed.match,
    rationale: parsed.rationale,
    rawResponse: responseText,
  };
}

function buildPrompt(job: JobDetails): string {
  return [
    "You are classifying job listings for a 'vibe coder' role.",
    "A vibe coder role is focused on rapid prototyping, product hacking, shipping fast, and experimental engineering.",
    "Signals include: early-stage startups, fast iteration, product-minded engineering, shipping MVPs, automation, rapid AI tooling.",
    "Negative signals include: large enterprise, compliance-heavy roles, long-term maintenance only, or purely academic research.",
    "Return ONLY valid JSON with keys: match (boolean), rationale (short string <= 20 words).",
    "Job details:",
    `Title: ${job.title}`,
    `Company: ${job.company ?? "Unknown"}`,
    `Location: ${job.location ?? "Unknown"}`,
    `Tags: ${job.tags.length > 0 ? job.tags.join(", ") : "None"}`,
    `Description: ${job.description}`,
  ].join("\n");
}

async function callGemini(prompt: string, options: ClassifyOptions): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
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
  const direct = tryParseJson(normalized);
  if (direct) {
    return normalizeClassification(direct);
  }

  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = normalized.slice(start, end + 1);
    const parsed = tryParseJson(extracted);
    if (parsed) {
      return normalizeClassification(parsed);
    }
  }

  return null;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeClassification(value: unknown): { match: boolean; rationale: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { match?: unknown; rationale?: unknown };
  if (typeof record.match !== "boolean") {
    return null;
  }
  const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
  return {
    match: record.match,
    rationale: rationale || (record.match ? "Matches vibe-coder signals." : "Does not match vibe-coder signals."),
  };
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
