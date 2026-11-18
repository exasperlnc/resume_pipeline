import { readFileSync } from "node:fs";
import { openDb, type DB } from "../src/db.js";
import type { FetchFn } from "../src/ingest/types.js";

export function memoryDb(): DB {
  return openDb(":memory:");
}

export function fixture(ats: string, name: string): unknown {
  const url = new URL(`./fixtures/${ats}/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/** A fetch stand-in that serves queued responses and records requests. */
export function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn: FetchFn = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no response queued");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  };
  return { fn, calls };
}

export function addCompany(db: DB, name: string, ats: string, token: string | null, watch = 1): number {
  return Number(
    db
      .prepare("INSERT INTO companies (name, ats, board_token, watch) VALUES (?, ?, ?, ?)")
      .run(name, ats, token, watch).lastInsertRowid,
  );
}

export const noSleep = async () => {};
