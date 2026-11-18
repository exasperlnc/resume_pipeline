import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { ashbyJobBoardUrl, parseAshby } from "../src/ingest/ashby.js";
import { greenhouseJobsUrl, parseGreenhouse } from "../src/ingest/greenhouse.js";
import { leverPostingsUrl, parseLever } from "../src/ingest/lever.js";
import { ingestAll } from "../src/ingest/run.js";
import type { NormalizedPosting } from "../src/ingest/types.js";
import { addCompany, fakeFetch, fixture, memoryDb, noSleep } from "./helpers.js";

const T1 = "2026-11-18 10:00:00";
const T2 = "2026-11-18 16:00:00";
const T3 = "2026-11-19 10:00:00";

interface Row {
  external_id: string;
  title: string;
  raw_text: string;
  content_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
}

function rows(db: DB): Record<string, Row> {
  const all = db.prepare<[], Row>("SELECT * FROM postings").all();
  return Object.fromEntries(all.map((r) => [r.external_id, r]));
}

function extractQueue(db: DB): string[] {
  return db
    .prepare<[], { external_id: string }>(
      "SELECT p.external_id FROM extract_queue q JOIN postings p ON p.id = q.id",
    )
    .all()
    .map((r) => r.external_id)
    .sort();
}

/** Pretend stage 2 extracted every open posting at its current hash. */
function markAllExtracted(db: DB) {
  db.exec(`INSERT OR REPLACE INTO posting_extracts (posting_id, content_hash)
           SELECT id, content_hash FROM postings WHERE closed_at IS NULL`);
}

/**
 * Every ATS has the same three fixtures describing the same three jobs:
 * initial (A, B, C), changed (A retitled, B's text edited), closed (C gone).
 */
const CASES: Array<{
  ats: string;
  url: string;
  parse: (body: unknown) => NormalizedPosting[];
}> = [
  { ats: "greenhouse", url: greenhouseJobsUrl("acme"), parse: parseGreenhouse },
  { ats: "lever", url: leverPostingsUrl("acme"), parse: parseLever },
  { ats: "ashby", url: ashbyJobBoardUrl("acme"), parse: parseAshby },
];

describe.each(CASES)("$ats ingest", ({ ats, url, parse }) => {
  const [A, B, C] = parse(fixture(ats, "initial")).map((p) => p.externalId) as [string, string, string];
  let db: DB;

  async function poll(fixtureName: string, now: string) {
    const { fn, calls } = fakeFetch([{ body: fixture(ats, fixtureName) }]);
    const results = await ingestAll(db, { fetch: fn, now: () => now, sleep: noSleep });
    return { results, calls };
  }

  beforeEach(() => {
    db = memoryDb();
    addCompany(db, "Acme", ats, "acme");
  });

  it("inserts new postings with one polite request", async () => {
    const { results, calls } = await poll("initial", T1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.headers["User-Agent"]).toMatch(/resume-pipeline/);
    expect(results[0]).toMatchObject({ status: "ok", result: { inserted: 3, closed: 0 } });

    const r = rows(db);
    expect(Object.keys(r).sort()).toEqual([A, B, C].sort());
    expect(r[A]).toMatchObject({ first_seen_at: T1, last_seen_at: T1, closed_at: null });
    expect(r[A]!.raw_text).not.toMatch(/<|&lt;|&amp;|https:/);
    expect(extractQueue(db)).toEqual([A, B, C].sort());

    const fts = db.prepare("SELECT rowid FROM postings_fts WHERE postings_fts MATCH 'typescript'").all();
    expect(fts).toHaveLength(1);
  });

  it("unchanged re-poll only bumps last_seen_at and queues nothing", async () => {
    await poll("initial", T1);
    markAllExtracted(db);
    const before = rows(db);

    const { results } = await poll("initial", T2);
    expect(results[0]!.result).toEqual({
      inserted: 0, textChanged: 0, metaChanged: 0, unchanged: 3, reopened: 0, closed: 0,
    });
    const after = rows(db);
    for (const id of [A, B, C]) expect(after[id]).toEqual({ ...before[id], last_seen_at: T2 });
    expect(extractQueue(db)).toEqual([]);
  });

  it("changed text re-enters the extract queue; a title-only change does not", async () => {
    await poll("initial", T1);
    markAllExtracted(db);
    const before = rows(db);

    const { results } = await poll("changed", T2);
    expect(results[0]!.result).toMatchObject({ textChanged: 1, metaChanged: 1, unchanged: 1 });

    const after = rows(db);
    expect(after[B]!.content_hash).not.toBe(before[B]!.content_hash);
    expect(after[B]!.raw_text).toContain("on-site");
    expect(after[B]!.first_seen_at).toBe(T1);
    expect(after[A]!.title).toBe("Software Engineer II, Platform");
    expect(after[A]!.content_hash).toBe(before[A]!.content_hash);
    expect(extractQueue(db)).toEqual([B]);

    const hits = db.prepare(`SELECT rowid FROM postings_fts WHERE postings_fts MATCH '"on-site"'`).all();
    expect(hits).toHaveLength(1);
  });

  it("closes postings that disappear, keeps them, and reopens them if they return", async () => {
    await poll("initial", T1);

    const closedRun = await poll("closed", T2);
    expect(closedRun.results[0]!.result).toMatchObject({ closed: 1, unchanged: 2 });
    let r = rows(db);
    expect(Object.keys(r)).toHaveLength(3); // nothing deleted
    expect(r[C]).toMatchObject({ closed_at: T2, last_seen_at: T1 });
    expect(r[A]!.closed_at).toBeNull();
    expect(extractQueue(db)).not.toContain(C);

    await poll("closed", T3); // a second poll without it does not move closed_at
    expect(rows(db)[C]!.closed_at).toBe(T2);

    const back = await poll("initial", T3);
    expect(back.results[0]!.result).toMatchObject({ reopened: 1, closed: 0 });
    r = rows(db);
    expect(r[C]).toMatchObject({ closed_at: null, last_seen_at: T3 });
  });
});

describe("ingest run", () => {
  let db: DB;
  beforeEach(() => {
    db = memoryDb();
    addCompany(db, "Acme", "greenhouse", "acme");
  });

  it("a failed fetch closes nothing and the run continues with other boards", async () => {
    addCompany(db, "Beta", "lever", "beta");
    await ingestAll(db, {
      fetch: fakeFetch([{ body: fixture("greenhouse", "initial") }, { body: [] }]).fn,
      now: () => T1,
      sleep: noSleep,
    }); // Acme then Beta, alphabetical

    const { fn } = fakeFetch([{ status: 404 }, { body: fixture("lever", "closed") }]);
    const results = await ingestAll(db, { fetch: fn, now: () => T2, sleep: noSleep });

    expect(results.map((x) => x.status)).toEqual(["error", "ok"]);
    expect(results[0]!.error).toMatch(/404/);
    const open = db.prepare("SELECT COUNT(*) AS n FROM postings WHERE closed_at IS NULL").get() as { n: number };
    expect(open.n).toBe(5); // Acme's 3 untouched, Beta's 2 new
  });

  it("ignores unwatched companies and skips ones without an adapter", async () => {
    addCompany(db, "Zed", "greenhouse", "zed", 0);
    addCompany(db, "Otherco", "other", "otherco");
    const { fn, calls } = fakeFetch([{ body: fixture("greenhouse", "initial") }]);
    const results = await ingestAll(db, { fetch: fn, now: () => T1, sleep: noSleep });
    expect(calls).toHaveLength(1);
    expect(results.map((x) => [x.name, x.status])).toEqual([
      ["Acme", "ok"],
      ["Otherco", "skipped"],
    ]);
  });
});
