import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import type { ExtractOutput } from "../src/extract/schema.js";
import { seedSkills } from "../src/extract/skills.js";
import { saveExtract } from "../src/extract/store.js";
import { buildMarketData } from "../src/market/data.js";
import { locationBuckets } from "../src/market/locations.js";
import { checkReportNumbers, createClaudeInterpreter } from "../src/market/report.js";
import { DEFAULT_TARGETS } from "../src/market/targets.js";
import { addCompany, memoryDb } from "./helpers.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const T = "2026-11-18 10:00:00";

function extract(overrides: Partial<ExtractOutput> = {}): ExtractOutput {
  return {
    role_type: "swe",
    seniority: "mid",
    metro: "Seattle, WA",
    remote_policy: "hybrid",
    min_years: 3,
    salary_min: 120000,
    salary_max: 140000,
    summary: "Builds things.",
    skills: [],
    ...overrides,
  };
}

let nextId = 1;
function addPosting(db: DB, companyId: number, title: string, locationRaw: string | null, e: ExtractOutput | null, closed = false) {
  const id = nextId++;
  db.prepare(
    `INSERT INTO postings (id, company_id, external_id, url, title, location_raw, raw_text, content_hash, first_seen_at, last_seen_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'text', 'h', ?, ?, ?)`,
  ).run(id, companyId, `x${id}`, `https://jobs.example/${id}`, title, locationRaw, T, T, closed ? T : null);
  if (e) saveExtract(db, id, "h", e, "test-model", T);
  return id;
}

function fixtureDb() {
  const db = memoryDb();
  seedSkills(db);
  const acme = addCompany(db, "Acme", "greenhouse", "acme");
  const demo = addCompany(db, "Demo", "lever", "demo", 0);
  addCompany(db, "Workday Co", "other", null);
  const ts = { name: "TypeScript", category: "language" as const, required: true };
  const py = { name: "Python", category: "language" as const, required: false };

  addPosting(db, acme, "Software Engineer II", "Seattle, WA", extract({ skills: [ts, py] }));
  addPosting(db, acme, "Software Engineer", "Remote - US", extract({ seniority: "junior", metro: "Remote", remote_policy: "remote", salary_min: null, salary_max: null, skills: [ts] }));
  addPosting(db, acme, "Senior Software Engineer", "Austin, TX", extract({ seniority: "senior", metro: "Austin, TX", salary_min: 180000, salary_max: 220000, skills: [ts] }));
  addPosting(db, acme, "Implementation Specialist", "Irvine, CA, Austin, TX", extract({ role_type: "implementation", metro: "Irvine, CA", salary_min: 70000, salary_max: 80000 }));
  addPosting(db, acme, "Software Engineer, Dublin", "Dublin, Ireland, Remote", extract({ metro: "Remote", remote_policy: "remote" }));
  addPosting(db, acme, "Account Executive", "Seattle, WA", extract({ role_type: "other" }));
  addPosting(db, acme, "Closed Engineer", "Seattle, WA", extract(), true);
  addPosting(db, acme, "Not extracted yet", "Seattle, WA", null);
  addPosting(db, demo, "Demo Engineer", "Seattle, WA", extract());
  return db;
}

describe("locationBuckets", () => {
  const b = (locationRaw: string | null, metro: string | null = null, remotePolicy: string | null = "unknown") =>
    locationBuckets({ locationRaw, metro, remotePolicy });

  it("puts a multi-location posting in every bucket it lists", () => {
    expect(b("Seattle, WA; Austin, TX; Remote - US")).toEqual(["Seattle", "Austin", "Remote (US)"]);
    expect(b("Irvine, CA, Austin, TX", "Irvine, CA")).toEqual(["Austin"]);
  });

  it("folds suburbs into their metro", () => {
    expect(b("Bellevue, WA")).toEqual(["Seattle"]);
    expect(b(null, "Seattle, WA")).toEqual(["Seattle"]);
  });

  it("counts US and unspecified remote, but not remote elsewhere", () => {
    expect(b("Remote")).toEqual(["Remote (US)"]);
    expect(b("United States", null, "remote")).toEqual(["Remote (US)"]);
    expect(b("Remote - Texas; Remote - Colorado")).toEqual(["Remote (US)"]);
    expect(b("Remote - United States; Remote - Canada")).toEqual(["Remote (US)"]);
    expect(b("Remote - Colombia")).toEqual([]);
    expect(b("Belfast, Northern Ireland, Remote")).toEqual([]);
    expect(b("Toronto", "Toronto, Canada", "remote")).toEqual([]);
  });

  it("returns nothing for other places", () => {
    expect(b("New York, NY", "New York, NY", "hybrid")).toEqual([]);
  });
});

describe("buildMarketData", () => {
  const data = buildMarketData(fixtureDb(), DEFAULT_TARGETS, NOW);

  it("counts only open, watched postings and reports what was left out", () => {
    expect(data.scope).toMatchObject({
      companies: 2,
      openPostings: 7,
      extracted: 6,
      notYetExtracted: 1,
      excludedCompanies: ["Demo"],
      untrackedCompanies: ["Workday Co"],
    });
  });

  it("summarizes each role at the target levels", () => {
    const swe = data.roles.find((r) => r.roleType === "swe")!;
    expect(swe).toMatchObject({ open: 4, atLevel: 3, medianMinYears: 3 });
    expect(swe.bySeniority).toMatchObject({ junior: 1, mid: 2, senior: 1 });
    // midpoints in $k: 130 (Seattle), 200 (senior Austin), 130 (Dublin); the remote one has no salary
    expect(swe.salaryK).toEqual({ n: 3, p25: 130, median: 130, p75: 165 });
    expect(swe.salaryKAtLevel).toEqual({ n: 2, p25: 130, median: 130, p75: 130 });
    expect(swe.salaryCoveragePct).toBe(75);
  });

  it("matches on role, level and any listed target location", () => {
    expect(data.matchesTotal).toBe(3);
    expect(data.matches.map((m) => m.title).sort()).toEqual(["Implementation Specialist", "Software Engineer", "Software Engineer II"]);
    const impl = data.matches.find((m) => m.roleType === "implementation")!;
    expect(impl.locations).toEqual(["Austin"]);
    expect(impl.salaryK).toEqual([70, 80]);
    const austinSwe = data.locations.find((l) => l.location === "Austin" && l.roleType === "swe")!;
    expect(austinSwe).toMatchObject({ open: 1, atLevel: 0 });
  });

  it("ranks skills by share of the role's postings", () => {
    const swe = data.skills.find((s) => s.roleType === "swe")!;
    expect(swe.top[0]).toEqual({ skill: "TypeScript", category: "language", postings: 3, pct: 75, requiredPct: 100 });
    expect(swe.top[1]).toMatchObject({ skill: "Python", postings: 1, pct: 25, requiredPct: 0 });
    expect(swe.atLevelTop).toBeNull(); // 3 at-level postings is below the minimum sample
  });

  it("ranks companies by matches", () => {
    expect(data.companies).toEqual([{ company: "Acme", industry: null, open: 6, targetRoles: 5, matches: 3 }]);
  });

  it("leaves churn and gaps out until there is data for them", () => {
    expect(data.history.daysOfData).toBe(2);
    expect(data.churn).toBeNull();
    expect(data.gaps).toBeNull();
  });

  it("reports churn after a week of history", () => {
    const db = fixtureDb();
    db.prepare(`UPDATE postings SET first_seen_at = '2026-11-24 09:00:00' WHERE title = 'Software Engineer'`).run();
    db.prepare(`UPDATE postings SET closed_at = '2026-11-25 09:00:00' WHERE title = 'Closed Engineer'`).run();
    const later = buildMarketData(db, DEFAULT_TARGETS, new Date("2026-11-26T12:00:00Z"));
    expect(later.churn).toEqual({ windowDays: 7, newPostings: 1, closedPostings: 1, newMatches: 1 });
  });
});

describe("checkReportNumbers", () => {
  const data = buildMarketData(fixtureDb(), DEFAULT_TARGETS, NOW);

  it("accepts numbers from the snapshot in their usual written forms", () => {
    const md = "# Market report, 2026-11-20\n\nSWE pays $130k (n=3), 75% list TypeScript, see [link](https://jobs.example/12345). $130,000 too.";
    expect(checkReportNumbers(md, data)).toEqual([]);
  });

  it("flags computed figures", () => {
    expect(checkReportNumbers("Pay averages $147k, and 42% are remote.", data)).toEqual(["$147k", "42"]);
  });
});

describe("createClaudeInterpreter", () => {
  function fakeClient(message: Partial<Anthropic.Message>) {
    const calls: unknown[] = [];
    const client = {
      messages: {
        stream: (params: unknown) => {
          calls.push(params);
          return { finalMessage: async () => ({ model: "claude-test", stop_reason: "end_turn", content: [], ...message }) };
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  }
  const data = buildMarketData(fixtureDb(), DEFAULT_TARGETS, NOW);

  it("sends the snapshot and returns the text", async () => {
    const { client, calls } = fakeClient({
      content: [
        { type: "thinking", thinking: "", signature: "s" } as never,
        { type: "text", text: "# Market report\n", citations: null } as never,
      ],
    });
    const out = await createClaudeInterpreter({ client })(data);
    expect(out).toEqual({ markdown: "# Market report", model: "claude-test" });
    const params = calls[0] as { model: string; messages: { content: string }[] };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.messages[0]!.content).toContain('"matchesTotal": 3');
  });

  it("fails on a truncated or refused report", async () => {
    await expect(createClaudeInterpreter({ client: fakeClient({ stop_reason: "max_tokens" }).client })(data)).rejects.toThrow(/max_tokens/);
    await expect(createClaudeInterpreter({ client: fakeClient({ stop_reason: "refusal" }).client })(data)).rejects.toThrow(/declined/);
  });
});
