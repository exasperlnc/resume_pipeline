import { z } from "zod";
import { toSqliteTime } from "../db.js";
import { htmlToPlainText } from "./text.js";
import type { AtsAdapter, NormalizedPosting } from "./types.js";

// Verified 2026-11-18 against https://developers.ashbyhq.com/docs/public-job-posting-api
// and a live board. `id` is not in the docs' field table but is always present, and
// compensation arrives per job, not at the top level as the docs' example suggests.
const AshbyJob = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  isListed: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
  compensation: z
    .object({
      scrapeableCompensationSalarySummary: z.string().nullish(),
      compensationTierSummary: z.string().nullish(),
    })
    .nullish(),
});
type AshbyJob = z.infer<typeof AshbyJob>;

const AshbyJobBoard = z.object({ jobs: z.array(AshbyJob) });

export function ashbyJobBoardUrl(boardToken: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=true`;
}

function ashbyFooter(j: AshbyJob): string {
  const lines: string[] = [];
  if (j.workplaceType) lines.push(`Workplace: ${j.workplaceType}`);
  const comp = j.compensation?.compensationTierSummary ?? j.compensation?.scrapeableCompensationSalarySummary;
  if (comp) lines.push(`Compensation: ${comp}`);
  return lines.join("\n");
}

export function parseAshby(body: unknown): NormalizedPosting[] {
  const { jobs } = AshbyJobBoard.parse(body);
  return (
    jobs
      // Unlisted jobs are reachable only by direct link, so they are not on the public board.
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]
          .map((l) => l?.trim())
          .filter((l): l is string => !!l);
        const description = j.descriptionHtml
          ? htmlToPlainText(j.descriptionHtml)
          : (j.descriptionPlain ?? "").trim();
        return {
          externalId: j.id,
          url: j.jobUrl,
          title: j.title.trim(),
          locationRaw: locations.length > 0 ? [...new Set(locations)].join("; ") : null,
          rawText: [description, ashbyFooter(j)].filter(Boolean).join("\n\n"),
          postedAt: toSqliteTime(j.publishedAt),
        };
      })
  );
}

export const ashby: AtsAdapter = {
  name: "ashby",
  async fetchPostings(boardToken, http) {
    return parseAshby(await http.getJson(ashbyJobBoardUrl(boardToken)));
  },
};
