import { sqliteNow, type DB } from "../db.js";
import { ExtractError, type ExtractInput, type Extractor } from "./schema.js";
import { seedSkills } from "./skills.js";
import { saveExtract } from "./store.js";

export interface ExtractRunOptions {
  /** Process at most this many postings (cost control). Default: the whole queue. */
  limit?: number;
  /** Calls in flight at once. */
  concurrency?: number;
  now?: () => string;
  log?: (line: string) => void;
}

export interface ExtractRunResult {
  queued: number;
  extracted: number;
  failed: Array<{ postingId: number; error: string }>;
}

interface QueueRow extends ExtractInput {
  contentHash: string;
}

/** Work through extract_queue: one model call per posting, saved as each one finishes. */
export async function runExtract(db: DB, extract: Extractor, opts: ExtractRunOptions = {}): Promise<ExtractRunResult> {
  const now = opts.now ?? (() => sqliteNow());
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  seedSkills(db);

  const queue = db
    .prepare<[number], QueueRow>(
      `SELECT p.id AS postingId, c.name AS company, p.title, p.location_raw AS locationRaw,
              p.raw_text AS rawText, p.content_hash AS contentHash
         FROM extract_queue q
         JOIN postings p  ON p.id = q.id
         JOIN companies c ON c.id = q.company_id
        ORDER BY p.first_seen_at DESC, p.id
        LIMIT ?`,
    )
    .all(opts.limit ?? -1);

  const result: ExtractRunResult = { queued: queue.length, extracted: 0, failed: [] };
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const row = queue[next++]!;
      const { contentHash, ...input } = row;
      try {
        const { output, model } = await extract(input);
        saveExtract(db, row.postingId, contentHash, output, model, now());
        result.extracted++;
        log(`ok    #${row.postingId} ${row.company}: ${row.title} -> ${output.role_type}/${output.seniority}, ${output.skills.length} skills`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ postingId: row.postingId, error });
        log(`error #${row.postingId} ${row.company}: ${row.title}: ${error}`);
        // An outage or credentials problem fails every remaining call too; stop instead of
        // burning through the queue. Errors from outside the extractor are treated the same way.
        if (!(err instanceof ExtractError) || err.stopsRun) next = queue.length;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}
