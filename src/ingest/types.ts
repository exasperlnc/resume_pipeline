/** One job as every ATS adapter must hand it to the store, already normalized. */
export interface NormalizedPosting {
  externalId: string;
  url: string;
  title: string;
  locationRaw: string | null;
  /** Description with HTML stripped. */
  rawText: string;
  /** SQLite UTC timestamp, or null when the board does not say. */
  postedAt: string | null;
}

export type FetchFn = typeof fetch;

export interface AtsAdapter {
  name: "greenhouse" | "lever" | "ashby";
  /** Fetch the full public job list for one board in a single request. */
  fetchPostings(boardToken: string, http: HttpClient): Promise<NormalizedPosting[]>;
}

export interface HttpClient {
  getJson(url: string): Promise<unknown>;
}
