import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { DB } from "./db.js";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const CompanyRow = z.object({
  name: z.string().trim().min(1),
  ats: z.preprocess(
    (v) => blankToNull(typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(["greenhouse", "lever", "ashby", "other"]).nullable(),
  ),
  board_token: z.preprocess(blankToNull, z.string().trim().nullable()).default(null),
  website: z.preprocess(blankToNull, z.string().trim().nullable()).default(null),
  industry: z.preprocess(blankToNull, z.string().trim().nullable()).default(null),
  watch: z.preprocess(
    (v) => (blankToNull(v) === null ? 1 : Number(v)),
    z.union([z.literal(0), z.literal(1)]),
  ).default(1),
});
export type CompanyRow = z.infer<typeof CompanyRow>;

/** Parse a companies CSV with a header row. Throws with the line number on a bad row. */
export function parseCompaniesCsv(csv: string): CompanyRow[] {
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, comment: "#" }) as Record<string, string>[];
  return records.map((rec, i) => {
    const parsed = CompanyRow.safeParse(rec);
    if (!parsed.success) {
      throw new Error(`row ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    if (parsed.data.ats && parsed.data.ats !== "other" && !parsed.data.board_token) {
      throw new Error(`row ${i + 2}: ${parsed.data.name} has ats '${parsed.data.ats}' but no board_token`);
    }
    return parsed.data;
  });
}

/** Upsert companies by name. Returns how many were inserted and updated. */
export function upsertCompanies(db: DB, rows: CompanyRow[]): { inserted: number; updated: number } {
  const exists = db.prepare<[string], { id: number }>("SELECT id FROM companies WHERE name = ?");
  const upsert = db.prepare(
    `INSERT INTO companies (name, ats, board_token, website, industry, watch)
     VALUES (@name, @ats, @board_token, @website, @industry, @watch)
     ON CONFLICT(name) DO UPDATE SET
       ats = excluded.ats, board_token = excluded.board_token,
       website = COALESCE(excluded.website, website),
       industry = COALESCE(excluded.industry, industry),
       watch = excluded.watch`,
  );
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (exists.get(row.name)) updated++;
      else inserted++;
      upsert.run(row);
    }
  })();
  return { inserted, updated };
}
