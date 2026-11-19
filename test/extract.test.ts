import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db.js";
import { createClaudeExtractor, DEFAULT_EXTRACT_MODEL } from "../src/extract/claude.js";
import { SYSTEM_PROMPT } from "../src/extract/prompt.js";
import { runExtract } from "../src/extract/run.js";
import { ExtractError, normalizeMetro, sanitizeExtract, type ExtractInput, type ExtractOutput, type Extractor } from "../src/extract/schema.js";
import { createSkillResolver, seedSkills, skillKey } from "../src/extract/skills.js";
import { ingestAll } from "../src/ingest/run.js";
import { addCompany, fakeFetch, fixture, memoryDb, noSleep } from "./helpers.js";

const T1 = "2026-11-18 10:00:00";

function output(overrides: Partial<ExtractOutput> = {}): ExtractOutput {
  return {
    role_type: "swe",
    seniority: "mid",
    metro: "Seattle, WA",
    remote_policy: "hybrid",
    min_years: 3,
    salary_min: 140000,
    salary_max: 180000,
    summary: "Builds platform services.",
    skills: [],
    ...overrides,
  };
}

/** Canned model output per posting title, as the fixture postings' titles appear. */
const CANNED: Record<string, ExtractOutput> = {
  "Software Engineer, Platform": output({
    skills: [
      { name: "TypeScript", category: "language", required: true },
      { name: "Postgres", category: "database", required: false },
      { name: "PostgreSQL", category: "database", required: true }, // same skill, required wins
      { name: "NodeJS", category: "framework", required: false },
    ],
  }),
  "Software Engineer II, Platform": output({
    skills: [{ name: "TypeScript", category: "language", required: true }],
  }),
  "Forward Deployed Engineer": output({
    role_type: "forward_deployed",
    metro: "Remote",
    remote_policy: "remote",
    salary_min: null,
    salary_max: null,
    skills: [
      { name: "Python", category: "language", required: true },
      { name: "Client communication", category: "soft", required: true },
    ],
  }),
  "Solutions Engineer": output({
    role_type: "solutions_engineer",
    metro: "Austin, TX",
    skills: [{ name: "Temporal", category: "framework", required: false }],
  }),
};

function fakeExtractor(fail: Record<string, Error> = {}, override: Record<string, ExtractOutput> = {}) {
  const calls: ExtractInput[] = [];
  const fn: Extractor = async (input) => {
    calls.push(input);
    if (fail[input.title]) throw fail[input.title];
    const out = override[input.title] ?? CANNED[input.title];
    if (!out) throw new Error(`no canned output for ${input.title}`);
    return { output: out, model: "fake-model" };
  };
  return { fn, calls };
}

async function ingest(db: DB, name: string, now = T1) {
  await ingestAll(db, { fetch: fakeFetch([{ body: fixture("greenhouse", name) }]).fn, now: () => now, sleep: noSleep });
}

function queueSize(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM extract_queue").get() as { n: number }).n;
}

describe("skills", () => {
  let db: DB;
  beforeEach(() => {
    db = memoryDb();
    seedSkills(db);
  });

  it("skillKey collapses punctuation and case but keeps C++ and C# distinct", () => {
    expect(skillKey("Node.js")).toBe(skillKey("NodeJS"));
    expect(skillKey("node js")).toBe("nodejs");
    expect(skillKey("C++")).not.toBe(skillKey("C"));
    expect(skillKey("C#")).not.toBe(skillKey("C++"));
  });

  it("seeding is idempotent", () => {
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n;
    const before = count();
    seedSkills(db);
    expect(count()).toBe(before);
    expect(before).toBeGreaterThan(50);
  });

  it("resolves aliases and spelling variants to one skill", () => {
    const resolve = createSkillResolver(db);
    const node = resolve("Node.js", "framework");
    expect(resolve("NodeJS", null)).toBe(node);
    expect(resolve("node", null)).toBe(node);
    expect(resolve("node js", null)).toBe(node);
    expect(resolve("Golang", null)).toBe(resolve("Go", null));
    expect(resolve("K8s", null)).toBe(resolve("kubernetes", null));
  });

  it("creates unknown skills once and finds them again by variant", () => {
    const resolve = createSkillResolver(db);
    const id = resolve("Temporal", "framework");
    expect(resolve("temporal", null)).toBe(id);
    expect(db.prepare("SELECT name, category FROM skills WHERE id = ?").get(id)).toEqual({ name: "Temporal", category: "framework" });
  });
});

describe("normalizeMetro", () => {
  it("spells out country codes but leaves US states alone", () => {
    expect(normalizeMetro("London, UK")).toBe("London, United Kingdom");
    expect(normalizeMetro("Wilmington, DE")).toBe("Wilmington, DE");
    expect(normalizeMetro("Indianapolis, IN")).toBe("Indianapolis, IN");
    expect(normalizeMetro("Tokyo, JP")).toBe("Tokyo, Japan");
  });
  it("folds suburbs and remote variants into one metro", () => {
    expect(normalizeMetro("Palo Alto, CA")).toBe("San Francisco, CA");
    expect(normalizeMetro("Bengaluru, India")).toBe("Bangalore, India");
    expect(normalizeMetro("New York City, NY")).toBe("New York, NY");
    expect(normalizeMetro("Remote, France")).toBe("Remote");
    expect(normalizeMetro("  ")).toBeNull();
  });
});

describe("sanitizeExtract", () => {
  it("swaps reversed salaries, drops implausible values, rounds, trims", () => {
    expect(sanitizeExtract(output({ salary_min: 200000, salary_max: 150000 }))).toMatchObject({ salary_min: 150000, salary_max: 200000 });
    expect(sanitizeExtract(output({ salary_min: 55, salary_max: 9e9 }))).toMatchObject({ salary_min: null, salary_max: null });
    expect(sanitizeExtract(output({ min_years: 2.6 })).min_years).toBe(3);
    expect(sanitizeExtract(output({ min_years: -1 })).min_years).toBeNull();
    expect(sanitizeExtract(output({ metro: "  " })).metro).toBeNull();
    const skills = sanitizeExtract(output({ skills: [{ name: "  Go ", category: "language", required: true }, { name: "", category: "soft", required: true }] })).skills;
    expect(skills).toEqual([{ name: "Go", category: "language", required: true }]);
  });
});

describe("runExtract", () => {
  let db: DB;
  beforeEach(async () => {
    db = memoryDb();
    addCompany(db, "Acme", "greenhouse", "acme");
    await ingest(db, "initial");
  });

  it("extracts every queued posting, collapses skill aliases, and empties the queue", async () => {
    const { fn, calls } = fakeExtractor();
    const result = await runExtract(db, fn, { now: () => T1 });

    expect(result).toEqual({ queued: 3, extracted: 3, failed: [] });
    expect(calls.map((c) => c.company)).toEqual(["Acme", "Acme", "Acme"]);
    expect(calls[0]!.rawText.length).toBeGreaterThan(0);
    expect(queueSize(db)).toBe(0);

    const row = db
      .prepare("SELECT e.role_type, e.metro, e.model, e.content_hash = p.content_hash AS hash_ok FROM posting_extracts e JOIN postings p ON p.id = e.posting_id WHERE p.external_id = '4002'")
      .get();
    expect(row).toEqual({ role_type: "forward_deployed", metro: "Remote", model: "fake-model", hash_ok: 1 });

    const skills = db
      .prepare(
        `SELECT s.name, ps.required FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id
           JOIN postings p ON p.id = ps.posting_id WHERE p.external_id = '4001' ORDER BY s.name`,
      )
      .all();
    expect(skills).toEqual([
      { name: "Node.js", required: 0 },
      { name: "PostgreSQL", required: 1 },
      { name: "TypeScript", required: 1 },
    ]);

    // Feeds the market views.
    const demand = db.prepare("SELECT role_type, skill, postings FROM skill_demand WHERE skill = 'Customer-facing communication'").all();
    expect(demand).toEqual([{ role_type: "forward_deployed", skill: "Customer-facing communication", postings: 1 }]);
  });

  it("re-extracts only postings whose text changed, replacing their skills", async () => {
    await runExtract(db, fakeExtractor().fn, { now: () => T1 });
    await ingest(db, "changed", "2026-11-18 16:00:00");
    expect(queueSize(db)).toBe(1); // 4002's text changed; 4001 was only retitled

    const { fn, calls } = fakeExtractor({}, {
      "Forward Deployed Engineer": output({ role_type: "forward_deployed", skills: [{ name: "Golang", category: "language", required: true }] }),
    });
    const result = await runExtract(db, fn, { now: () => T1 });
    expect(result.extracted).toBe(1);
    expect(calls.map((c) => c.title)).toEqual(["Forward Deployed Engineer"]);
    const names = db
      .prepare("SELECT s.name FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id JOIN postings p ON p.id = ps.posting_id WHERE p.external_id = '4002'")
      .all();
    expect(names).toEqual([{ name: "Go" }]);
    expect(queueSize(db)).toBe(0);
  });

  it("keeps going past a bad posting and leaves it queued", async () => {
    const { fn } = fakeExtractor({ "Forward Deployed Engineer": new ExtractError("model declined (cyber)", false) });
    const result = await runExtract(db, fn, { now: () => T1, concurrency: 1 });
    expect(result.extracted).toBe(2);
    expect(result.failed).toEqual([{ postingId: expect.any(Number), error: "model declined (cyber)" }]);
    expect(queueSize(db)).toBe(1);
  });

  it("stops early when the API is unavailable", async () => {
    const outage = new ExtractError("API unavailable: overloaded", true);
    const { fn, calls } = fakeExtractor({
      "Software Engineer, Platform": outage,
      "Forward Deployed Engineer": outage,
      "Solutions Engineer": outage,
    });
    const result = await runExtract(db, fn, { now: () => T1, concurrency: 1 });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ queued: 3, extracted: 0 });
    expect(queueSize(db)).toBe(3);
  });

  it("respects limit", async () => {
    const { fn, calls } = fakeExtractor();
    await runExtract(db, fn, { now: () => T1, limit: 2 });
    expect(calls).toHaveLength(2);
    expect(queueSize(db)).toBe(1);
  });
});

describe("createClaudeExtractor", () => {
  const input: ExtractInput = { postingId: 1, company: "Acme", title: "SWE", locationRaw: "Seattle, WA", rawText: "Build things in Go." };

  function fakeClient(response: unknown) {
    const parse = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return { client: { messages: { parse } } as unknown as Anthropic, parse };
  }

  it("sends a cacheable system prompt, low effort and the structured output format", async () => {
    const { client, parse } = fakeClient({
      stop_reason: "end_turn",
      model: DEFAULT_EXTRACT_MODEL,
      parsed_output: output({ salary_min: 200000, salary_max: 100000 }),
    });
    const result = await createClaudeExtractor({ client, model: DEFAULT_EXTRACT_MODEL })(input);

    const params = (parse.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.messages[0].content).toContain("Company: Acme");
    expect(params.messages[0].content).toContain("<posting>\nBuild things in Go.\n</posting>");
    expect(SYSTEM_PROMPT).not.toContain("Acme"); // nothing per-posting in the cached prefix
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.output).toMatchObject({ salary_min: 100000, salary_max: 200000 }); // sanitized
  });

  it("treats refusals and truncation as per-posting errors", async () => {
    const refusal = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null });
    await expect(createClaudeExtractor({ client: refusal.client })(input)).rejects.toMatchObject({
      message: "model declined (cyber)",
      stopsRun: false,
    });
    const truncated = fakeClient({ stop_reason: "max_tokens", parsed_output: null });
    await expect(createClaudeExtractor({ client: truncated.client })(input)).rejects.toMatchObject({ stopsRun: false });
  });

  it("stops the run on outages, bad or missing credentials; not on a single bad request", async () => {
    const limited = fakeClient(new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()));
    await expect(createClaudeExtractor({ client: limited.client })(input)).rejects.toMatchObject({ stopsRun: true });
    const denied = fakeClient(new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()));
    await expect(createClaudeExtractor({ client: denied.client })(input)).rejects.toMatchObject({ stopsRun: true });
    const missing = fakeClient(new Anthropic.AnthropicError("Could not resolve authentication method"));
    await expect(createClaudeExtractor({ client: missing.client })(input)).rejects.toMatchObject({ stopsRun: true });
    const bad = fakeClient(new Anthropic.BadRequestError(400, undefined, "bad", new Headers()));
    await expect(createClaudeExtractor({ client: bad.client })(input)).rejects.toMatchObject({ stopsRun: false });
  });
});
