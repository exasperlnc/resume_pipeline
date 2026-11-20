import type { RoleType, Seniority } from "../extract/schema.js";

/** What the job seeker is looking for. Mirrors "Targets" in CLAUDE.md. */
export interface Targets {
  roleTypes: RoleType[];
  /** Levels counted as "at your level". "unknown" is reported separately, never counted as a match. */
  seniorities: Seniority[];
  locations: LocationBucket[];
}

export const LOCATION_BUCKETS = ["Seattle", "Austin", "Remote (US)"] as const;
export type LocationBucket = (typeof LOCATION_BUCKETS)[number];

export const DEFAULT_TARGETS: Targets = {
  roleTypes: ["swe", "forward_deployed", "solutions_engineer", "implementation"],
  seniorities: ["intern", "junior", "mid"],
  locations: [...LOCATION_BUCKETS],
};
