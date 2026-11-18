import { z } from "zod";
import { toSqliteTime } from "../db.js";
import { htmlToPlainText } from "./text.js";
import type { AtsAdapter, NormalizedPosting } from "./types.js";

// Verified 2026-11-18 against https://docs.greenhouse.io/job-board.html (List Jobs)
// and a live board response. Unknown fields pass through untouched.
const GreenhouseJob = z.object({
  id: z.number().int(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string().nullish(),
  // Not in the documented list shape, but returned in practice.
  first_published: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
});

const GreenhouseJobList = z.object({
  jobs: z.array(GreenhouseJob),
  meta: z.object({ total: z.number() }).partial().nullish(),
});

export function greenhouseJobsUrl(boardToken: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
}

export function parseGreenhouse(body: unknown): NormalizedPosting[] {
  const { jobs } = GreenhouseJobList.parse(body);
  return jobs.map((j) => ({
    externalId: String(j.id),
    url: j.absolute_url,
    title: j.title.trim(),
    locationRaw: j.location?.name?.trim() || null,
    rawText: htmlToPlainText(j.content ?? ""),
    postedAt: toSqliteTime(j.first_published),
  }));
}

export const greenhouse: AtsAdapter = {
  name: "greenhouse",
  async fetchPostings(boardToken, http) {
    return parseGreenhouse(await http.getJson(greenhouseJobsUrl(boardToken)));
  },
};
