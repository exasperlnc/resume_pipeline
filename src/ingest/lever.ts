import { encode } from "he";
import { z } from "zod";
import { sqliteNow } from "../db.js";
import { htmlToPlainText } from "./text.js";
import type { AtsAdapter, NormalizedPosting } from "./types.js";

// Verified 2026-11-18 against https://github.com/lever/postings-api and live boards.
// Without skip/limit the endpoint returns every published posting in one array.
const LeverPosting = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  // Epoch milliseconds. Not documented, but returned in practice.
  createdAt: z.number().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  description: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additional: z.string().nullish(),
  workplaceType: z.string().nullish(),
  salaryDescription: z.string().nullish(),
  salaryRange: z
    .object({
      currency: z.string().nullish(),
      interval: z.string().nullish(),
      min: z.number().nullish(),
      max: z.number().nullish(),
    })
    .nullish(),
});
type LeverPosting = z.infer<typeof LeverPosting>;

/**
 * board_token is the Lever site name. Prefix it with "eu:" for boards hosted
 * on Lever's EU instance, e.g. "eu:acme".
 */
export function leverPostingsUrl(boardToken: string): string {
  const eu = boardToken.startsWith("eu:");
  const site = eu ? boardToken.slice(3) : boardToken;
  const host = eu ? "api.eu.lever.co" : "api.lever.co";
  return `https://${host}/v0/postings/${encodeURIComponent(site)}?mode=json`;
}

/** Lever splits a posting into an opening/body, headed lists and a closing section. */
function leverHtml(p: LeverPosting): string {
  const parts = [p.description ?? ""];
  for (const list of p.lists ?? []) {
    if (list.text) parts.push(`<h3>${encode(list.text)}</h3>`);
    if (list.content) parts.push(`<ul>${list.content}</ul>`);
  }
  if (p.additional) parts.push(p.additional);
  if (p.salaryDescription) parts.push(p.salaryDescription);
  return parts.join("\n");
}

/** Structured fields the description may not state, kept as text for stage 2. */
function leverFooter(p: LeverPosting): string {
  const lines: string[] = [];
  if (p.workplaceType && p.workplaceType !== "unspecified") lines.push(`Workplace: ${p.workplaceType}`);
  const s = p.salaryRange;
  if (s && (s.min != null || s.max != null)) {
    const range = [s.min, s.max].filter((n) => n != null).join(" - ");
    lines.push(`Salary range: ${range} ${s.currency ?? ""} ${s.interval ?? ""}`.replace(/\s+/g, " ").trim());
  }
  return lines.join("\n");
}

export function parseLever(body: unknown): NormalizedPosting[] {
  const postings = z.array(LeverPosting).parse(body);
  return postings.map((p) => {
    const all = p.categories?.allLocations?.filter(Boolean) ?? [];
    const location = all.length > 0 ? all.join("; ") : p.categories?.location?.trim() || null;
    const text = [htmlToPlainText(leverHtml(p)), leverFooter(p)].filter(Boolean).join("\n\n");
    return {
      externalId: p.id,
      url: p.hostedUrl,
      title: p.text.trim(),
      locationRaw: location,
      rawText: text,
      postedAt: p.createdAt != null ? sqliteNow(new Date(p.createdAt)) : null,
    };
  });
}

export const lever: AtsAdapter = {
  name: "lever",
  async fetchPostings(boardToken, http) {
    return parseLever(await http.getJson(leverPostingsUrl(boardToken)));
  },
};
