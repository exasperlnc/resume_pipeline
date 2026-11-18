import type { FetchFn, HttpClient } from "./types.js";

export const USER_AGENT =
  "resume-pipeline-ingest/0.1 (personal job search tool; polls public job boards once per run)";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface HttpOptions {
  fetch?: FetchFn;
  /** Attempts in total, including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** JSON GET with a real User-Agent and exponential backoff on 429, 5xx and network errors. */
export function createHttpClient(opts: HttpOptions = {}): HttpClient {
  const doFetch = opts.fetch ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  return {
    async getJson(url) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let retryAfterMs: number | undefined;
        try {
          const res = await doFetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.ok) return await res.json();
          lastError = new HttpError(res.status, url);
          if (!RETRYABLE.has(res.status)) throw lastError;
          retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        } catch (err) {
          if (err instanceof HttpError && !RETRYABLE.has(err.status)) throw err;
          lastError = err;
        }
        if (attempt < maxAttempts) {
          const backoff = Math.min(cap, base * 2 ** (attempt - 1));
          await sleep(Math.min(cap, Math.max(backoff, retryAfterMs ?? 0)));
        }
      }
      throw lastError;
    },
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
