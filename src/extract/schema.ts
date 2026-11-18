import { z } from "zod";

/** Role types we track. Anything else is "other" so market views stay comparable. */
export const ROLE_TYPES = ["swe", "forward_deployed", "solutions_engineer", "implementation", "other"] as const;
export const SENIORITIES = ["intern", "junior", "mid", "senior", "staff", "unknown"] as const;
export const REMOTE_POLICIES = ["onsite", "hybrid", "remote", "unknown"] as const;
export const SKILL_CATEGORIES = ["language", "framework", "database", "cloud", "practice", "soft"] as const;

export const ExtractedSkill = z.object({
  name: z.string().describe("Skill name, using the vocabulary's canonical spelling when one fits"),
  category: z.enum(SKILL_CATEGORIES),
  required: z.boolean().describe("true if required, false if listed as nice-to-have / preferred / bonus"),
});

/** What the model returns for one posting. Field names match posting_extracts. */
export const ExtractOutput = z.object({
  role_type: z.enum(ROLE_TYPES),
  seniority: z.enum(SENIORITIES),
  metro: z.string().nullable().describe("e.g. 'Seattle, WA', 'Remote', or null if unclear"),
  remote_policy: z.enum(REMOTE_POLICIES),
  min_years: z.number().nullable(),
  salary_min: z.number().nullable().describe("Annual base salary in USD"),
  salary_max: z.number().nullable().describe("Annual base salary in USD"),
  summary: z.string().describe("2 to 3 sentences"),
  skills: z.array(ExtractedSkill),
});
export type ExtractOutput = z.infer<typeof ExtractOutput>;

/** One posting as the extractor sees it. */
export interface ExtractInput {
  postingId: number;
  company: string;
  title: string;
  locationRaw: string | null;
  rawText: string;
}

export interface ExtractResult {
  output: ExtractOutput;
  /** Model id that produced the row, stored in posting_extracts.model. */
  model: string;
}

export type Extractor = (input: ExtractInput) => Promise<ExtractResult>;

export class ExtractError extends Error {
  constructor(
    message: string,
    /** True when every later call would fail the same way (outage, bad credentials), so the run should stop. */
    readonly stopsRun: boolean,
  ) {
    super(message);
  }
}

/**
 * Fix values the schema cannot rule out: reversed or implausible salary ranges,
 * impossible years, blank strings. Keeps the database consistent for the views.
 */
export function sanitizeExtract(o: ExtractOutput): ExtractOutput {
  // The schema uses plain numbers (integer bounds would leak into the prompt), so round here.
  const round = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n));
  const plausibleSalary = (n: number | null) => {
    const r = round(n);
    return r !== null && r >= 10_000 && r <= 2_000_000 ? r : null;
  };
  const years = round(o.min_years);
  let salary_min = plausibleSalary(o.salary_min);
  let salary_max = plausibleSalary(o.salary_max);
  if (salary_min !== null && salary_max !== null && salary_min > salary_max) {
    [salary_min, salary_max] = [salary_max, salary_min];
  }
  const metro = o.metro?.trim() || null;
  return {
    ...o,
    metro,
    min_years: years !== null && years >= 0 && years <= 30 ? years : null,
    salary_min,
    salary_max,
    summary: o.summary.trim(),
    skills: o.skills
      .map((s) => ({ ...s, name: s.name.trim() }))
      .filter((s) => s.name.length > 0 && s.name.length <= 60),
  };
}
