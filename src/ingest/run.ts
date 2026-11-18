import { sqliteNow, type DB } from "../db.js";
import { greenhouse } from "./greenhouse.js";
import { createHttpClient, type HttpOptions } from "./http.js";
import { syncPostings, type SyncResult } from "./store.js";
import type { AtsAdapter } from "./types.js";

export const ADAPTERS: Partial<Record<string, AtsAdapter>> = {
  greenhouse,
};

export interface CompanyRunResult {
  companyId: number;
  name: string;
  ats: string | null;
  status: "ok" | "skipped" | "error";
  result?: SyncResult;
  error?: string;
}

interface WatchedCompany {
  id: number;
  name: string;
  ats: string | null;
  board_token: string | null;
}

export interface IngestOptions extends HttpOptions {
  now?: () => string;
  log?: (line: string) => void;
}

/**
 * Poll every watched company's board once. A failed fetch or parse leaves that
 * company's postings untouched (nothing gets closed) and the run continues.
 */
export async function ingestAll(db: DB, opts: IngestOptions = {}): Promise<CompanyRunResult[]> {
  const http = createHttpClient(opts);
  const now = opts.now ?? (() => sqliteNow());
  const log = opts.log ?? (() => {});

  const companies = db
    .prepare<[], WatchedCompany>(
      `SELECT id, name, ats, board_token FROM companies WHERE watch = 1 ORDER BY name`,
    )
    .all();

  const results: CompanyRunResult[] = [];
  for (const c of companies) {
    const base = { companyId: c.id, name: c.name, ats: c.ats };
    const adapter = c.ats ? ADAPTERS[c.ats] : undefined;
    if (!adapter || !c.board_token) {
      const error = !c.board_token
        ? "no board_token"
        : `no adapter for ats '${c.ats ?? "null"}'`;
      log(`skip  ${c.name}: ${error}`);
      results.push({ ...base, status: "skipped", error });
      continue;
    }
    try {
      const postings = await adapter.fetchPostings(c.board_token, http);
      const result = syncPostings(db, c.id, postings, now());
      log(
        `ok    ${c.name}: ${postings.length} listed, +${result.inserted} new, ` +
          `${result.textChanged} changed, ${result.metaChanged} meta, ` +
          `${result.reopened} reopened, ${result.closed} closed`,
      );
      results.push({ ...base, status: "ok", result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`error ${c.name}: ${error}`);
      results.push({ ...base, status: "error", error });
    }
  }
  return results;
}
