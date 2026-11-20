import type { LocationBucket } from "./targets.js";

export interface LocatedPosting {
  locationRaw: string | null;
  metro: string | null;
  remotePolicy: string | null;
}

const SEATTLE = /\b(seattle|bellevue|redmond|kirkland)\b/i;
const AUSTIN = /\b(austin|round rock)\b/i;
const REMOTE = /\bremote\b/i;

// A remote posting counts as US-remote unless it names only non-US places.
// "Remote - United States; Remote - Canada" is US; "Remote - Colombia" and
// "Belfast, Northern Ireland, Remote" are not. A bare "Remote" is treated as US,
// since every company in the list is US-headquartered.
const NON_US =
  /\b(canada|toronto|vancouver|montreal|alberta|ontario|quebec|british columbia|manitoba|nova scotia|ireland|dublin|belfast|united kingdom|uk|england|london|india|gurugram|gurgaon|bangalore|bengaluru|hyderabad|germany|poland|colombia|costa rica|mexico|brazil|argentina|spain|france|netherlands|australia|sydney|japan|singapore|philippines|taipei|taiwan|emea|apac|latam|europe)\b/i;
const US =
  /\b(united states|usa?|u\.s\.?|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming)\b/i;

function isRemote(p: LocatedPosting): boolean {
  return p.remotePolicy === "remote" || p.metro === "Remote" || REMOTE.test(p.locationRaw ?? "");
}

function isUsRemote(p: LocatedPosting): boolean {
  if (!isRemote(p)) return false;
  const raw = p.locationRaw ?? "";
  return !NON_US.test(raw) || US.test(raw);
}

/**
 * Every target location a posting can be worked from. A posting listing
 * "Seattle; Austin; Remote - US" lands in all three, unlike the extract's
 * single primary metro.
 */
export function locationBuckets(p: LocatedPosting): LocationBucket[] {
  const raw = p.locationRaw ?? "";
  const out: LocationBucket[] = [];
  if (p.metro === "Seattle, WA" || SEATTLE.test(raw)) out.push("Seattle");
  if (p.metro === "Austin, TX" || AUSTIN.test(raw)) out.push("Austin");
  if (isUsRemote(p)) out.push("Remote (US)");
  return out;
}
