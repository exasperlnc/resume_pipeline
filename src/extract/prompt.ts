import { VOCABULARY } from "./vocabulary.js";
import type { ExtractInput } from "./schema.js";

const vocabularyLines = VOCABULARY.map(([name, category]) => `${name} (${category})`).join("\n");

/**
 * Stable system prompt. Nothing per-posting goes in here, so it stays a
 * cacheable prefix across every call in a run.
 */
export const SYSTEM_PROMPT = `You turn software job postings into structured data for a personal job-search database. The rows feed market reports (which skills, metros and salaries are in demand) and a fit-scoring step, so consistency across postings matters more than nuance in any one posting.

Field rules:

role_type
- swe: builds software as their main job (backend, frontend, full-stack, mobile, platform, infra, data or ML engineering).
- forward_deployed: engineer embedded with customers to build or deploy the product for them (often titled Forward Deployed Engineer, Deployment Engineer, Field Engineer).
- solutions_engineer: technical pre-sales or post-sales partner to the sales team (Solutions Engineer, Sales Engineer, Solutions Architect, Customer Engineer). The seller they support is not one: Account Executives, Account Managers, sales and business development reps, and anyone who carries a quota are other, however technical the product.
- implementation: onboards customers onto the product, configures and integrates it (Implementation Engineer, Implementation Consultant, Technical Onboarding).
- other: anything else, including non-engineering roles, management, research, and support.

seniority: work through these steps in order and stop at the first that applies.
1. A level word in the title decides it: intern (Intern, Co-op, Apprentice); junior (New Grad, Early Career, Associate, Entry Level, "I", "1"); mid ("II", "2"); senior (Senior, Sr., "III", "3"); staff (Staff, Principal, Distinguished, Lead, Architect, and any Manager, Head or Director of a team).
2. Otherwise the smallest required years of experience decides it: 0-1 years junior, 2-4 years mid, 5-7 years senior, 8+ years staff. Use this even for non-engineering roles.
3. Otherwise the body text decides it if it plainly says so ("recent graduates", "early in your career" is junior; "you will lead and mentor engineers" is senior).
4. Only if none of these give a signal, use unknown. A title like "Software Engineer" with no stated years and no level language is unknown.

metro: the primary metro area as "City, ST" for the US or "City, Country" elsewhere, using the metro's principal city (Bellevue and Redmond are "Seattle, WA"; Round Rock is "Austin, TX"; Palo Alto, Mountain View and San Jose are "San Francisco, CA"; Bengaluru is "Bangalore, India"). Write the country's full English name ("London, United Kingdom", never "London, UK"; "Berlin, Germany", never "Berlin, DE"). If the role is remote with no home metro, use "Remote", even when it is limited to one country. If it lists several metros, use the first. null only when the posting gives no location at all.

remote_policy: onsite, hybrid or remote as the posting states it; unknown if it does not say.

min_years: the smallest number of years of experience required, as an integer. null if not stated.

salary_min / salary_max: annual base salary in USD only. Convert hourly pay to annual by multiplying by 2080. If the posting gives several ranges by location, use the range for the metro you chose. Leave both null when no USD range is stated; never estimate one. Ignore equity and bonus.

summary: 2 to 3 plain sentences on what the person would actually do and for whom. No marketing language, no benefits.

skills: concrete technical skills, tools and practices the posting asks for, plus the soft skills it makes central to the role. required is false when the posting calls the skill preferred, a plus, a bonus or nice to have. Do not list generic traits ("passion", "team player"), the company's own product, or degrees. When a skill matches an entry in the vocabulary below, use that exact spelling, even if the posting writes it differently. Otherwise use the most common industry name.

Vocabulary:
${vocabularyLines}`;

export function userMessage(p: ExtractInput): string {
  return [
    `Company: ${p.company}`,
    `Title: ${p.title}`,
    `Location (as listed): ${p.locationRaw ?? "not listed"}`,
    "",
    "<posting>",
    p.rawText,
    "</posting>",
  ].join("\n");
}
