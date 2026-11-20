import Anthropic from "@anthropic-ai/sdk";
import type { MarketData } from "./data.js";

export const DEFAULT_REPORT_MODEL = "claude-opus-5-5";

export const REPORT_SYSTEM_PROMPT = `You write a market intelligence report for one person's software job search. The input is a JSON snapshot computed from job postings at the companies they watch. Your reader is the job seeker: they want to know where the jobs at their level are, what to learn, and which companies to focus on.

How to read the snapshot:
- targets: the role types, levels ("seniorities") and locations they want. A "match" is an open posting with a target role type, a target level and at least one target location.
- roles[].atLevel counts postings at a target level. bySeniority.unknown is a posting that gave no level signal; it is not a match, but some unknowns may be open to them.
- locations: a posting can be in several location buckets at once.
- skills[].top is computed over all postings of the role at every level; atLevelTop over at-level postings only, and is null when the sample was too small. pct is the share of the role's postings that mention the skill; requiredPct is, of those, the share that require it rather than list it as a plus.
- salaryK values are annual base pay midpoints in thousands of USD; n is how many postings stated a range. Salary is often missing, so always say how many postings a salary figure rests on.
- churn is null until there is a full week of history. gaps is null when their fact bank (their own recorded experience) is empty.
- scope.untrackedCompanies are on their watch list but use a job board that isn't ingested, so they contribute no data. scope.excludedCompanies are deliberately left out.

Rules:
- Every number you write must appear in the snapshot exactly as given (salaries may be written as "$131k"). Do not add, subtract, average or compute new percentages. If a comparison needs a number the snapshot lacks, describe it in words instead.
- When a figure rests on fewer than 8 postings, say the sample is small. Do not draw conclusions from a single posting.
- Be direct and specific. Name companies, roles and skills. No filler, no motivational language, no generic career advice that the data does not support.
- If churn is null, say in one sentence that trends will appear after a week of daily ingests. If gaps is null, say in one sentence that a skill gap analysis needs the fact bank filled in, and stop there.

Format: Markdown. Start with a level-1 heading "Market report, <asOf>". Then these sections, each a level-2 heading:
1. Summary: 3 to 5 bullets, the most decision-relevant findings first.
2. Where the openings are: roles by location at their level, and how much of each role is senior-only.
3. What employers ask for: the skills that recur across their target roles, separating near-universal requirements from nice-to-haves. Call out skills that show up in several target roles.
4. Pay: what the salary data supports, with sample sizes.
5. Companies: which watched companies have matches, which have target roles but none at their level, and which contribute nothing.
6. Open matches: a table of every posting in matches (company, title, role type, level, min years, locations, pay). If matchesTotal is larger than the list, say how many were left out.
7. Data caveats: coverage limits worth knowing before acting on this report, briefly.`;

export interface ReportResult {
  markdown: string;
  model: string;
}

export type Interpreter = (data: MarketData) => Promise<ReportResult>;

export function createClaudeInterpreter(opts: { client?: Anthropic; model?: string } = {}): Interpreter {
  const client = opts.client ?? new Anthropic({ maxRetries: 4 });
  const model = opts.model ?? DEFAULT_REPORT_MODEL;
  return async (data) => {
    const response = await client.messages
      .stream({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: REPORT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `<snapshot>\n${JSON.stringify(data, null, 1)}\n</snapshot>` }],
      })
      .finalMessage();
    if (response.stop_reason === "refusal") throw new Error("The model declined to write the report.");
    if (response.stop_reason === "max_tokens") throw new Error("The report hit max_tokens before finishing.");
    const markdown = response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
      .trim();
    if (!markdown) throw new Error("The model returned no report text.");
    return { markdown, model: response.model };
  };
}

/** Every number that appears anywhere in the snapshot, including inside strings like titles and dates. */
function allowedNumbers(data: unknown): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === "number") out.add(v);
    else if (typeof v === "string") for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

/**
 * Numbers in the report that the snapshot doesn't contain. The prompt forbids
 * computing new figures; this catches the ones that slip through. Small counts
 * (0 to 10) are allowed because they show up as list positions and in prose.
 */
export function checkReportNumbers(markdown: string, data: MarketData): string[] {
  const allowed = allowedNumbers(data);
  const prose = markdown.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
  const unsupported = new Set<string>();
  for (const m of prose.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g)) {
    const token = m[0].trim();
    let n = Number(m[1]!.replace(/,/g, ""));
    if (!m[2] && token.startsWith("$") && n >= 1000) n = n / 1000;
    if (Number.isInteger(n) && n >= 0 && n <= 10) continue;
    if (!allowed.has(n)) unsupported.add(token);
  }
  return [...unsupported];
}
