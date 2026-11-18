import { describe, expect, it } from "vitest";
import { parseCompaniesCsv, upsertCompanies } from "../src/seed.js";
import { memoryDb } from "./helpers.js";

const CSV = `# comment
name,ats,board_token,website,industry,watch
Acme,Greenhouse,acme,https://acme.example,,
"Beta, Inc",lever,beta,,fintech,0
Gamma,other,,,,
`;

describe("seed", () => {
  it("parses rows with defaults, quoting and case-insensitive ats", () => {
    expect(parseCompaniesCsv(CSV)).toEqual([
      { name: "Acme", ats: "greenhouse", board_token: "acme", website: "https://acme.example", industry: null, watch: 1 },
      { name: "Beta, Inc", ats: "lever", board_token: "beta", website: null, industry: "fintech", watch: 0 },
      { name: "Gamma", ats: "other", board_token: null, website: null, industry: null, watch: 1 },
    ]);
  });

  it("rejects an unknown ats or a missing board_token with the line number", () => {
    expect(() => parseCompaniesCsv("name,ats,board_token\nX,workday,x\n")).toThrow(/row 2/);
    expect(() => parseCompaniesCsv("name,ats,board_token\nX,greenhouse,\n")).toThrow(/row 2.*board_token/);
  });

  it("upserts by name and is safe to re-run", () => {
    const db = memoryDb();
    expect(upsertCompanies(db, parseCompaniesCsv(CSV))).toEqual({ inserted: 3, updated: 0 });
    const again = parseCompaniesCsv("name,ats,board_token,watch\nAcme,greenhouse,acme-new,0\n");
    expect(upsertCompanies(db, again)).toEqual({ inserted: 0, updated: 1 });
    expect(db.prepare("SELECT board_token, website, watch FROM companies WHERE name = 'Acme'").get()).toEqual({
      board_token: "acme-new",
      website: "https://acme.example",
      watch: 0,
    });
  });
});
