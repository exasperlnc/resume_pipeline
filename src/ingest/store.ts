import type { DB } from "../db.js";
import { contentHash } from "./text.js";
import type { NormalizedPosting } from "./types.js";

export interface SyncResult {
  inserted: number;
  /** Description text changed: content_hash differs, so stage 2 will re-extract. */
  textChanged: number;
  /** Title, URL, location or posted date changed, text did not. */
  metaChanged: number;
  unchanged: number;
  /** Was closed, is listed again. */
  reopened: number;
  closed: number;
}

interface ExistingRow {
  id: number;
  url: string;
  title: string;
  location_raw: string | null;
  content_hash: string;
  posted_at: string | null;
  closed_at: string | null;
}

/**
 * Reconcile one board's current listing with the database in a single transaction.
 * Upserts on (company_id, external_id), bumps last_seen_at on everything listed,
 * and sets closed_at on open postings that are no longer listed. Never deletes.
 */
export function syncPostings(
  db: DB,
  companyId: number,
  postings: NormalizedPosting[],
  now: string,
): SyncResult {
  const result: SyncResult = {
    inserted: 0,
    textChanged: 0,
    metaChanged: 0,
    unchanged: 0,
    reopened: 0,
    closed: 0,
  };

  const select = db.prepare<[number, string], ExistingRow>(
    `SELECT id, url, title, location_raw, content_hash, posted_at, closed_at
       FROM postings WHERE company_id = ? AND external_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO postings (company_id, external_id, url, title, location_raw, raw_text,
                           content_hash, posted_at, first_seen_at, last_seen_at)
     VALUES (@companyId, @externalId, @url, @title, @locationRaw, @rawText,
             @hash, @postedAt, @now, @now)`,
  );
  // Full rewrite only when something changed, so the FTS trigger fires only then.
  const update = db.prepare(
    `UPDATE postings SET url = @url, title = @title, location_raw = @locationRaw,
            raw_text = @rawText, content_hash = @hash, posted_at = @postedAt,
            last_seen_at = @now, closed_at = NULL
      WHERE id = @id`,
  );
  const touch = db.prepare(
    `UPDATE postings SET last_seen_at = @now, closed_at = NULL WHERE id = @id`,
  );
  const closeMissing = db.prepare(
    `UPDATE postings SET closed_at = @now
      WHERE company_id = @companyId AND closed_at IS NULL
        AND external_id NOT IN (SELECT value FROM json_each(@seen))`,
  );

  db.transaction(() => {
    const seen = new Set<string>();
    for (const p of postings) {
      // Boards occasionally list a job twice; the first wins.
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);

      const hash = contentHash(p.rawText);
      const row = select.get(companyId, p.externalId);
      const params = { ...p, companyId, hash, now };

      if (!row) {
        insert.run(params);
        result.inserted++;
        continue;
      }
      if (row.closed_at !== null) result.reopened++;

      if (row.content_hash !== hash) {
        update.run({ ...params, id: row.id });
        result.textChanged++;
      } else if (
        row.url !== p.url ||
        row.title !== p.title ||
        row.location_raw !== p.locationRaw ||
        (p.postedAt !== null && row.posted_at !== p.postedAt)
      ) {
        update.run({ ...params, postedAt: p.postedAt ?? row.posted_at, id: row.id });
        result.metaChanged++;
      } else {
        touch.run({ id: row.id, now });
        result.unchanged++;
      }
    }
    result.closed = closeMissing.run({
      companyId,
      now,
      seen: JSON.stringify([...seen]),
    }).changes;
  })();

  return result;
}
