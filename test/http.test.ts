import { describe, expect, it } from "vitest";
import { createHttpClient, HttpError } from "../src/ingest/http.js";
import { fakeFetch } from "./helpers.js";

describe("createHttpClient", () => {
  it("backs off exponentially on 5xx and network errors, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fn, calls } = fakeFetch([{ status: 503 }, new TypeError("fetch failed"), { body: { ok: 1 } }]);
    const http = createHttpClient({ fetch: fn, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    await expect(http.getJson("https://x.example")).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("honors Retry-After on 429", async () => {
    const sleeps: number[] = [];
    const { fn } = fakeFetch([{ status: 429, headers: { "retry-after": "5" } }, { body: [] }]);
    const http = createHttpClient({ fetch: fn, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    await http.getJson("https://x.example");
    expect(sleeps).toEqual([5000]);
  });

  it("does not retry a 404", async () => {
    const { fn, calls } = fakeFetch([{ status: 404 }]);
    const http = createHttpClient({ fetch: fn, sleep: async () => {} });
    await expect(http.getJson("https://x.example")).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxAttempts", async () => {
    const { fn, calls } = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const http = createHttpClient({ fetch: fn, maxAttempts: 3, sleep: async () => {} });
    await expect(http.getJson("https://x.example")).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(3);
  });
});
