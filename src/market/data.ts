import type Database from "better-sqlite3";
import { SENIORITIES, type RoleType, type Seniority } from "../extract/schema.js";
import { locationBuckets } from "./locations.js";
import type { LocationBucket, Targets } from "./targets.js";

/**
 * Everything the market report says comes from this object. Numbers are
 * pre-computed and pre-rounded (percentages as whole numbers, salaries in
 * thousands of USD) so the interpreting model never has to do arithmetic,
 * and so checkReportNumbers can verify the prose against it.
 */
export interface MarketData {
  asOf: string;
  targets: Targets;
  scope: {
    companies: number;
    companiesWithOpenings: number;
    openPostings: number;
    extracted: number;
    notYetExtracted: number;
    /** watch = 0 companies, left out of every number below. */
    excludedCompanies: string[];
    /** Watched companies whose board ingest can't read (ats = 'other'). */
    untrackedCompanies: string[];
  };
  history: { firstSeen: string | null; daysOfData: number };
  roles: RoleSummary[];
  locations: LocationSummary[];
  skills: RoleSkills[];
  companies: CompanySummary[];
  /** Open postings that match target role, level and location. Capped; see matchesTotal. */
  matches: Match[];
  matchesTotal: number;
  /** null until there is a full window of history; before that every posting looks new. */
  churn: { windowDays: number; newPostings: number; closedPostings: number; newMatches: number } | null;
  /** null when the fact bank is empty, so a gap list would just be every skill. */
  gaps: { roleType: RoleType; skills: { skill: string; postings: number; pct: number }[] }[] | null;
}

export interface SalaryK {
  n: number;
  p25: number;
  median: number;
  p75: number;
}

export interface RoleSummary {
  roleType: RoleType;
  open: number;
  pctOfAllOpen: number;
  bySeniority: Record<Seniority, number>;
  atLevel: number;
  atLevelPct: number;
  medianMinYears: number | null;
  medianMinYearsAtLevel: number | null;
  salaryK: SalaryK | null;
  salaryKAtLevel: SalaryK | null;
  /** Share of this role's postings that state a USD range. */
  salaryCoveragePct: number;
}

export interface LocationSummary {
  location: LocationBucket;
  roleType: RoleType;
  open: number;
  atLevel: number;
  salaryKAtLevel: SalaryK | null;
}

export interface RoleSkills {
  roleType: RoleType;
  basis: number;
  top: SkillRow[];
  /** Same, among at-level postings only; omitted when fewer than MIN_SAMPLE. */
  atLevelBasis: number;
  atLevelTop: SkillRow[] | null;
}

export interface SkillRow {
  skill: string;
  category: string | null;
  postings: number;
  pct: number;
  /** Of the postings that mention it, the share that require it. */
  requiredPct: number;
}

export interface CompanySummary {
  company: string;
  industry: string | null;
  open: number;
  targetRoles: number;
  matches: number;
}

export interface Match {
  company: string;
  title: string;
  roleType: RoleType;
  seniority: Seniority;
  minYears: number | null;
  locations: LocationBucket[];
  salaryK: [number, number] | null;
  url: string;
}

export const MIN_SAMPLE = 8;
const TOP_SKILLS = 15;
const MAX_MATCHES = 60;
const CHURN_DAYS = 7;

interface Row {
  id: number;
  company: string;
  title: string;
  url: string;
  locationRaw: string | null;
  firstSeenAt: string;
  roleType: RoleType;
  seniority: Seniority;
  metro: string | null;
  remotePolicy: string | null;
  minYears: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((100 * part) / whole));

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(quantile([...values].sort((a, b) => a - b), 0.5));
}

function salaryK(rows: Row[]): SalaryK | null {
  const mids = rows
    .filter((r) => r.salaryMin !== null && r.salaryMax !== null)
    .map((r) => (r.salaryMin! + r.salaryMax!) / 2000)
    .sort((a, b) => a - b);
  if (mids.length === 0) return null;
  return {
    n: mids.length,
    p25: Math.round(quantile(mids, 0.25)),
    median: Math.round(quantile(mids, 0.5)),
    p75: Math.round(quantile(mids, 0.75)),
  };
}

const daysBefore = (iso: string, days: number) =>
  new Date(Date.parse(iso.replace(" ", "T") + "Z") - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

export function buildMarketData(db: Database.Database, targets: Targets, now: Date = new Date()): MarketData {
  const nowSql = now.toISOString().slice(0, 19).replace("T", " ");
  const since = daysBefore(nowSql, CHURN_DAYS);

  // Only watched companies count. Closed postings are excluded except for churn.
  const rows = db
    .prepare(
      `SELECT p.id, c.name AS company, p.title, p.url, p.location_raw AS locationRaw,
              p.first_seen_at AS firstSeenAt, e.role_type AS roleType, e.seniority, e.metro,
              e.remote_policy AS remotePolicy, e.min_years AS minYears,
              e.salary_min AS salaryMin, e.salary_max AS salaryMax
       FROM postings p
       JOIN companies c ON c.id = p.company_id AND c.watch = 1
       JOIN posting_extracts e ON e.posting_id = p.id
       WHERE p.closed_at IS NULL`,
    )
    .all() as Row[];

  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const openPostings = count(
    `SELECT COUNT(*) AS n FROM postings p JOIN companies c ON c.id = p.company_id AND c.watch = 1 WHERE p.closed_at IS NULL`,
  );

  const located = new Map(rows.map((r) => [r.id, locationBuckets(r)]));
  const wanted = new Set(targets.locations);
  const atLevel = (r: Row) => targets.seniorities.includes(r.seniority);
  const inTargetLocation = (r: Row) => located.get(r.id)!.some((l) => wanted.has(l));
  const isMatch = (r: Row) => targets.roleTypes.includes(r.roleType) && atLevel(r) && inTargetLocation(r);

  const roles: RoleSummary[] = [...targets.roleTypes, "other" as const].map((roleType) => {
    const rs = rows.filter((r) => r.roleType === roleType);
    const lvl = rs.filter(atLevel);
    const bySeniority = Object.fromEntries(SENIORITIES.map((s) => [s, rs.filter((r) => r.seniority === s).length])) as Record<
      Seniority,
      number
    >;
    const years = (xs: Row[]) => median(xs.map((r) => r.minYears).filter((y): y is number => y !== null));
    return {
      roleType,
      open: rs.length,
      pctOfAllOpen: pct(rs.length, rows.length),
      bySeniority,
      atLevel: lvl.length,
      atLevelPct: pct(lvl.length, rs.length),
      medianMinYears: years(rs),
      medianMinYearsAtLevel: years(lvl),
      salaryK: salaryK(rs),
      salaryKAtLevel: salaryK(lvl),
      salaryCoveragePct: pct(rs.filter((r) => r.salaryMin !== null).length, rs.length),
    };
  });

  const locations: LocationSummary[] = [];
  for (const location of targets.locations) {
    for (const roleType of targets.roleTypes) {
      const rs = rows.filter((r) => r.roleType === roleType && located.get(r.id)!.includes(location));
      const lvl = rs.filter(atLevel);
      locations.push({ location, roleType, open: rs.length, atLevel: lvl.length, salaryKAtLevel: salaryK(lvl) });
    }
  }

  const skillStmt = db.prepare(
    `SELECT s.name AS skill, s.category, COUNT(*) AS postings, SUM(ps.required) AS required
     FROM posting_skills ps JOIN skills s ON s.id = ps.skill_id
     WHERE ps.posting_id IN (SELECT value FROM json_each(?))
     GROUP BY s.id ORDER BY postings DESC, s.name LIMIT ?`,
  );
  const topSkills = (rs: Row[]): SkillRow[] =>
    (
      skillStmt.all(JSON.stringify(rs.map((r) => r.id)), TOP_SKILLS) as {
        skill: string;
        category: string | null;
        postings: number;
        required: number;
      }[]
    ).map((s) => ({
      skill: s.skill,
      category: s.category,
      postings: s.postings,
      pct: pct(s.postings, rs.length),
      requiredPct: pct(s.required, s.postings),
    }));

  const skills: RoleSkills[] = targets.roleTypes.map((roleType) => {
    const rs = rows.filter((r) => r.roleType === roleType);
    const lvl = rs.filter(atLevel);
    return {
      roleType,
      basis: rs.length,
      top: topSkills(rs),
      atLevelBasis: lvl.length,
      atLevelTop: lvl.length >= MIN_SAMPLE ? topSkills(lvl) : null,
    };
  });

  const byCompany = new Map<string, Row[]>();
  for (const r of rows) byCompany.set(r.company, [...(byCompany.get(r.company) ?? []), r]);
  const watched = db
    .prepare(`SELECT name, industry, ats FROM companies WHERE watch = 1 ORDER BY name`)
    .all() as { name: string; industry: string | null; ats: string | null }[];
  const companies: CompanySummary[] = watched
    .filter((c) => c.ats !== "other")
    .map((c) => {
      const rs = byCompany.get(c.name) ?? [];
      return {
        company: c.name,
        industry: c.industry,
        open: rs.length,
        targetRoles: rs.filter((r) => targets.roleTypes.includes(r.roleType)).length,
        matches: rs.filter(isMatch).length,
      };
    })
    .sort((a, b) => b.matches - a.matches || b.targetRoles - a.targetRoles || a.company.localeCompare(b.company));

  const allMatches = rows
    .filter(isMatch)
    .sort((a, b) => a.roleType.localeCompare(b.roleType) || a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  const matches: Match[] = allMatches.slice(0, MAX_MATCHES).map((r) => ({
    company: r.company,
    title: r.title,
    roleType: r.roleType,
    seniority: r.seniority,
    minYears: r.minYears,
    locations: located.get(r.id)!.filter((l) => wanted.has(l)),
    salaryK: r.salaryMin !== null && r.salaryMax !== null ? [Math.round(r.salaryMin / 1000), Math.round(r.salaryMax / 1000)] : null,
    url: r.url,
  }));

  const firstSeen = (db.prepare(`SELECT MIN(first_seen_at) AS d FROM postings`).get() as { d: string | null }).d;
  const daysOfData = firstSeen ? Math.floor((Date.parse(nowSql.replace(" ", "T") + "Z") - Date.parse(firstSeen.replace(" ", "T") + "Z")) / 86_400_000) : 0;

  const factCount = count(`SELECT COUNT(*) AS n FROM facts WHERE active = 1`);
  const gaps =
    factCount === 0
      ? null
      : targets.roleTypes.map((roleType) => {
          const basis = rows.filter((r) => r.roleType === roleType).length;
          const gapRows = db
            .prepare(`SELECT skill, postings FROM skill_gaps WHERE role_type = ? ORDER BY postings DESC LIMIT ?`)
            .all(roleType, TOP_SKILLS) as { skill: string; postings: number }[];
          return { roleType, skills: gapRows.map((g) => ({ ...g, pct: pct(g.postings, basis) })) };
        });

  return {
    asOf: nowSql.slice(0, 10),
    targets,
    scope: {
      companies: watched.length,
      companiesWithOpenings: byCompany.size,
      openPostings,
      extracted: rows.length,
      notYetExtracted: openPostings - rows.length,
      excludedCompanies: (db.prepare(`SELECT name FROM companies WHERE watch = 0 ORDER BY name`).all() as { name: string }[]).map((c) => c.name),
      untrackedCompanies: watched.filter((c) => c.ats === "other").map((c) => c.name),
    },
    history: { firstSeen: firstSeen?.slice(0, 10) ?? null, daysOfData },
    roles,
    locations,
    skills,
    companies,
    matches,
    matchesTotal: allMatches.length,
    churn: daysOfData < CHURN_DAYS ? null : {
      windowDays: CHURN_DAYS,
      newPostings: count(
        `SELECT COUNT(*) AS n FROM postings p JOIN companies c ON c.id = p.company_id AND c.watch = 1 WHERE p.first_seen_at >= ?`,
        since,
      ),
      closedPostings: count(
        `SELECT COUNT(*) AS n FROM postings p JOIN companies c ON c.id = p.company_id AND c.watch = 1 WHERE p.closed_at >= ?`,
        since,
      ),
      newMatches: allMatches.filter((r) => r.firstSeenAt >= since).length,
    },
    gaps,
  };
}
