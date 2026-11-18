import { describe, expect, it } from "vitest";
import { ashbyJobBoardUrl, parseAshby } from "../src/ingest/ashby.js";
import { greenhouseJobsUrl, parseGreenhouse } from "../src/ingest/greenhouse.js";
import { leverPostingsUrl, parseLever } from "../src/ingest/lever.js";
import { fixture } from "./helpers.js";

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
    expect(greenhouseJobsUrl("acme")).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
  });
});

describe("parseLever", () => {
  it("joins description, headed lists and closing text, plus workplace and salary", () => {
    const [first, second, third] = parseLever(fixture("lever", "initial"));
    expect(first).toMatchObject({
      externalId: "0b6f2c1e-1111-4a5b-9c0d-000000000001",
      url: "https://jobs.lever.co/acme/0b6f2c1e-1111-4a5b-9c0d-000000000001",
      title: "Software Engineer, Platform",
      locationRaw: "Seattle, WA; Remote, US",
      postedAt: "2026-09-21 14:13:20",
    });
    const text = first!.rawText;
    expect(text).toContain("Acme builds tools & things.");
    expect(text).toContain("What you'll do");
    expect(text).toMatch(/\* Build TypeScript services/);
    expect(text).toContain("Apply here.");
    expect(text).toContain("Workplace: hybrid");
    expect(text).toContain("Salary range: 140000 - 180000 USD per-year-salary");
    expect(text.indexOf("What you'll do")).toBeLessThan(text.indexOf("Apply here"));
    expect(second!.rawText).toContain("Workplace: remote");
    expect(third!.rawText).not.toContain("Workplace"); // "unspecified" is dropped
  });

  it("escapes list headings so they cannot inject markup", () => {
    const [p] = parseLever([
      { id: "x", text: "T", hostedUrl: "https://e.example", lists: [{ text: "a <b> c", content: "<li>i</li>" }] },
    ]);
    expect(p!.rawText).toContain("a <b> c");
  });

  it("falls back to categories.location and tolerates missing fields", () => {
    const [p] = parseLever([
      { id: "x", text: "T", hostedUrl: "https://e.example", categories: { location: "Austin, TX" } },
    ]);
    expect(p).toMatchObject({ locationRaw: "Austin, TX", rawText: "", postedAt: null });
  });

  it("rejects a non-array response", () => {
    expect(() => parseLever({ ok: false, error: "Document not found" })).toThrow();
  });

  it("builds global and EU URLs", () => {
    expect(leverPostingsUrl("acme")).toBe("https://api.lever.co/v0/postings/acme?mode=json");
    expect(leverPostingsUrl("eu:acme")).toBe("https://api.eu.lever.co/v0/postings/acme?mode=json");
  });
});

describe("parseAshby", () => {
  it("normalizes jobs and drops unlisted ones", () => {
    const parsed = parseAshby(fixture("ashby", "initial"));
    expect(parsed.map((p) => p.title)).not.toContain("Unlisted Role");
    expect(parsed).toHaveLength(3);
    const [first] = parsed;
    expect(first).toMatchObject({
      externalId: "a5b1e0c2-1111-4f00-8e00-00000000000a",
      url: "https://jobs.ashbyhq.com/acme/a5b1e0c2-1111-4f00-8e00-00000000000a",
      locationRaw: "Seattle, WA; Remote, US",
      postedAt: "2026-10-01 13:00:00",
    });
    expect(first!.rawText).toContain("Acme builds tools & things.");
    expect(first!.rawText).toContain("Workplace: Hybrid");
    expect(first!.rawText).toContain("Compensation: $140K – $180K • Offers Equity");
    expect(first!.rawText).not.toContain("plain fallback");
  });

  it("uses descriptionPlain when there is no HTML", () => {
    const [p] = parseAshby({
      jobs: [{ id: "x", title: "T", jobUrl: "https://e.example", descriptionPlain: " Just text. " }],
    });
    expect(p).toMatchObject({ rawText: "Just text.", locationRaw: null, postedAt: null });
  });

  it("rejects a response without jobs", () => {
    expect(() => parseAshby({ apiVersion: "1" })).toThrow();
  });

  it("builds the board URL with compensation", () => {
    expect(ashbyJobBoardUrl("acme")).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
    );
  });
});
