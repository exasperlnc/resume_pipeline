import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { greenhouseJobsUrl, parseGreenhouse } from "../src/ingest/greenhouse.js";
import { ingestAll } from "../src/ingest/run.js";
import { addCompany, fakeFetch, fixture, memoryDb, noSleep } from "./helpers.js";

const T1 = "2026-11-18 10:00:00";
const T2 = "2026-11-18 16:00:00";
const T3 = "2026-11-19 10:00:00";

interface Row {
  external_id: string;
  title: string;
  location_raw: string | null;
  raw_text: string;
  content_hash: string;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
}

function rows(db: DB): Record<string, Row> {
  const all = db.prepare<[], Row>("SELECT * FROM postings ORDER BY external_id").all();
  return Object.fromEntries(all.map((r) => [r.external_id, r]));
}

function extractQueue(db: DB): string[] {
  return db
    .prepare<[], { external_id: string }>(
      "SELECT p.external_id FROM extract_queue q JOIN postings p ON p.id = q.id ORDER BY 1",
    )
    .all()
    .map((r) => r.external_id);
}

/** Pretend stage 2 extracted every open posting at its current hash. */
function markAllExtracted(db: DB) {
  db.exec(`INSERT OR REPLACE INTO posting_extracts (posting_id, content_hash)
           SELECT id, content_hash FROM postings WHERE closed_at IS NULL`);
}

async function poll(db: DB, fixtureName: string, now: string) {
  const { fn, calls } = fakeFetch([{ body: fixture("greenhouse", fixtureName) }]);
  const results = await ingestAll(db, { fetch: fn, now: () => now, sleep: noSleep });
  return { results, calls };
}

describe("parseGreenhouse", () => {
  it("normalizes the documented list shape", () => {
    const [first] = parseGreenhouse(fixture("greenhouse", "initial"));
    expect(first).toEqual({
      externalId: "4001",
      url: "https://job-boards.greenhouse.io/acme/jobs/4001",
      title: "Software Engineer, Platform",
      locationRaw: "Seattle, WA",
      rawText: expect.stringContaining("Acme builds tools & things."),
      postedAt: "2026-10-01 13:00:00",
    });
    expect(first!.rawText).not.toMatch(/<|&lt;|&amp;|https:/);
  });

  it("tolerates missing optional fields", () => {
    const [job] = parseGreenhouse({
      jobs: [{ id: 1, title: "X", absolute_url: "https://e.example/1", location: null }],
    });
    expect(job).toMatchObject({ locationRaw: null, rawText: "", postedAt: null });
  });

  it("rejects a response that is not a job list", () => {
    expect(() => parseGreenhouse({ error: "not found" })).toThrow();
  });

  it("builds the board URL with content=true", () => {
    expect(greenhouseJobsUrl("acme")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
  });
});

describe("greenhouse ingest", () => {
  let db: DB;
  beforeEach(() => {
    db = memoryDb();
    addCompany(db, "Acme", "greenhouse", "acme");
  });

  it("inserts new postings with one polite request", async () => {
    const { results, calls } = await poll(db, "initial", T1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(greenhouseJobsUrl("acme"));
    expect(calls[0]!.headers["User-Agent"]).toMatch(/resume-pipeline/);
    expect(results[0]).toMatchObject({ status: "ok", result: { inserted: 3, closed: 0 } });

    const r = rows(db);
    expect(Object.keys(r)).toEqual(["4001", "4002", "4003"]);
    expect(r["4001"]).toMatchObject({ first_seen_at: T1, last_seen_at: T1, closed_at: null });
    expect(extractQueue(db)).toEqual(["4001", "4002", "4003"]);

    const fts = db
      .prepare("SELECT rowid FROM postings_fts WHERE postings_fts MATCH 'typescript'")
      .all();
    expect(fts).toHaveLength(1);
  });

  it("unchanged re-poll only bumps last_seen_at and queues nothing", async () => {
    await poll(db, "initial", T1);
    markAllExtracted(db);
    const before = rows(db);

    const { results } = await poll(db, "initial", T2);
    expect(results[0]!.result).toEqual({
      inserted: 0, textChanged: 0, metaChanged: 0, unchanged: 3, reopened: 0, closed: 0,
    });
    const after = rows(db);
    for (const id of ["4001", "4002", "4003"]) {
      expect(after[id]).toEqual({ ...before[id], last_seen_at: T2 });
    }
    expect(extractQueue(db)).toEqual([]);
  });

  it("changed text gets a new hash and re-enters the extract queue; title-only change does not", async () => {
    await poll(db, "initial", T1);
    markAllExtracted(db);
    const before = rows(db);

    const { results } = await poll(db, "changed", T2);
    expect(results[0]!.result).toMatchObject({ textChanged: 1, metaChanged: 1, unchanged: 1 });

    const after = rows(db);
    expect(after["4002"]!.content_hash).not.toBe(before["4002"]!.content_hash);
    expect(after["4002"]!.raw_text).toContain("on-site");
    expect(after["4002"]!.first_seen_at).toBe(T1);
    expect(after["4001"]!.title).toBe("Software Engineer II, Platform");
    expect(after["4001"]!.content_hash).toBe(before["4001"]!.content_hash);
    expect(extractQueue(db)).toEqual(["4002"]);

    const hits = db
      .prepare("SELECT rowid FROM postings_fts WHERE postings_fts MATCH 'onsite OR \"on-site\"'")
      .all();
    expect(hits).toHaveLength(1);
  });

  it("closes postings that disappear, keeps them, and reopens them if they return", async () => {
    await poll(db, "initial", T1);

    const closedRun = await poll(db, "closed", T2);
    expect(closedRun.results[0]!.result).toMatchObject({ closed: 1, unchanged: 2 });
    let r = rows(db);
    expect(Object.keys(r)).toHaveLength(3); // nothing deleted
    expect(r["4003"]).toMatchObject({ closed_at: T2, last_seen_at: T1 });
    expect(r["4001"]!.closed_at).toBeNull();
    expect(extractQueue(db)).not.toContain("4003");

    // A second poll without it does not move closed_at.
    await poll(db, "closed", T3);
    expect(rows(db)["4003"]!.closed_at).toBe(T2);

    const back = await poll(db, "initial", T3);
    expect(back.results[0]!.result).toMatchObject({ reopened: 1, closed: 0 });
    r = rows(db);
    expect(r["4003"]).toMatchObject({ closed_at: null, last_seen_at: T3 });
  });

  it("a failed fetch closes nothing and the run continues with other boards", async () => {
    addCompany(db, "Beta", "greenhouse", "beta");
    await ingestAll(db, {
      fetch: fakeFetch([{ body: fixture("greenhouse", "initial") }, { body: { jobs: [] } }]).fn,
      now: () => T1,
      sleep: noSleep,
    }); // Acme then Beta, alphabetical

    const { fn } = fakeFetch([{ status: 404 }, { body: fixture("greenhouse", "closed") }]);
    const results = await ingestAll(db, { fetch: fn, now: () => T2, sleep: noSleep });

    expect(results.map((x) => x.status)).toEqual(["error", "ok"]);
    expect(results[0]!.error).toMatch(/404/);
    const open = db.prepare("SELECT COUNT(*) AS n FROM postings WHERE closed_at IS NULL").get() as { n: number };
    expect(open.n).toBe(5); // Acme's 3 untouched, Beta's 2 new
  });

  it("ignores unwatched companies and skips ones without an adapter", async () => {
    addCompany(db, "Zed", "greenhouse", "zed", 0);
    addCompany(db, "Leverco", "lever", "leverco");
    const { fn, calls } = fakeFetch([{ body: fixture("greenhouse", "initial") }]);
    const results = await ingestAll(db, { fetch: fn, now: () => T1, sleep: noSleep });
    expect(calls).toHaveLength(1);
    expect(results.map((x) => [x.name, x.status])).toEqual([
      ["Acme", "ok"],
      ["Leverco", "skipped"],
    ]);
  });
});
