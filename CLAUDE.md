# Job search pipeline

A personal system of workflows and one agent that systematizes a software job search. Everything reads and writes a single SQLite database (`jobs.db`), which acts as long-term storage so that LLM steps only load the few rows they need.

## Status

Design is done, `schema.sql` is written and tested. Stage 1 ingest is done for Greenhouse, Lever and Ashby (`src/ingest/`, one `AtsAdapter` per ATS registered in `src/ingest/run.ts`; fixtures in `test/fixtures/<ats>/`, lifecycle tests in `test/ingest.test.ts` run against every ATS). Lever EU boards use a `board_token` of `eu:<site>`.

Stage 2 extract is built (`src/extract/`): one structured-output call per row of `extract_queue`, defaulting to `claude-haiku-5-5` at low effort (override with `EXTRACT_MODEL`). Skill names resolve through `skill_aliases`, which is seeded from `src/extract/vocabulary.ts`; that vocabulary is also part of the cached system prompt, so append to it rather than reorder it.

Stage 7 market report is built (`src/market/`). `buildMarketData` turns the database into a pre-computed JSON snapshot (only `watch = 1` companies; a posting counts for every target location its `location_raw` lists, via `locationBuckets`), then one `claude-opus-5-5` call (override with `REPORT_MODEL`) writes the report, and `checkReportNumbers` flags any figure in the prose that isn't in the snapshot. Targets live in `src/market/targets.ts`. Reports go to `reports/` (gitignored). **Next: stage 3 (score and triage).**

Commands: `npm run seed -- companies.csv`, `npm run ingest`, `npm run extract -- [--limit N] [--concurrency N]`, `npm run report -- [--data-only] [--out DIR]`, `npm test`, `npm run typecheck`. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` for extract. The database path defaults to `jobs.db`; override it with `JOBS_DB`.

## Architecture

Most stages are plain pipelines with one LLM call each. Only company research is an open-ended agent.

| # | Stage | Kind | Reads | Writes |
|---|-------|------|-------|--------|
| 1 | Ingest postings | Plain code, scheduled | ATS job boards | `companies`, `postings` |
| 2 | Extract | Cheap LLM call per posting | `extract_queue` view | `posting_extracts`, `posting_skills`, `skills` |
| 3 | Score and triage | LLM call, human decision | extracts, `facts` | `fit_scores` |
| 4 | Company research | Agent, shortlisted companies only | web | `research_notes` |
| 5 | Tailor resume and cover letter | LLM call plus a checker pass | `facts`, extracts, `research_notes` | files, `applications`, `application_facts` |
| 6 | Submit and track | Manual submit, logged | | `applications`, `application_events` |
| 7 | Market intelligence | SQL views, LLM interprets | `skill_demand`, `skill_gaps`, `metro_demand` | reports |
| 8 | Interview prep | LLM call | posting, `research_notes` | study guides |

Build order: 1, 2, 7 first (they produce the dataset everything else needs), then 3, 4, 5, then 6 and 8.

## Rules that are not up for negotiation

- **No LinkedIn scraping.** Ingest only from public ATS job board endpoints (Greenhouse, Lever, Ashby) and other sources whose terms allow it.
- **Never auto-submit applications.** A human submits. The system prepares and tracks.
- **The fact bank is the only source for resume content.** Tailoring selects and rewords rows from `facts`. It never invents experience, numbers, or skills. The checker pass must map every resume claim to a row in `application_facts`.
- **Research notes need a source.** `research_notes.source_url` is NOT NULL on purpose.
- **The model scores, the human decides.** `fit_scores.decision` is set by the user only.

## Schema notes

- `schema.sql` is the source of truth. Create the database with `sqlite3 jobs.db < schema.sql`.
- `postings.content_hash` and `posting_extracts.content_hash` exist so re-polling costs zero LLM calls unless a posting's text changed. The `extract_queue` view is the work queue for stage 2.
- Resolve skill names through `skill_aliases` before inserting into `posting_skills`, so "Node", "NodeJS" and "Node.js" count as one skill.
- `postings_fts` is an FTS5 index kept in sync by triggers. Use it for keyword lookups instead of loading raw posting text in bulk.
- When a posting disappears from a board, set `closed_at`. Do not delete it. The views filter on `closed_at IS NULL`.

## Stage 1 spec: ingest

- Input: rows in `companies` where `watch = 1`, each with an `ats` and `board_token`.
- For each, fetch the board's public job list, upsert into `postings` on `(company_id, external_id)`.
- Strip HTML from descriptions before storing `raw_text`. Compute `content_hash` from the stripped text.
- Update `last_seen_at` on every posting still present. Set `closed_at` on postings that were open and are no longer listed.
- Be polite: one request per board per run, a real User-Agent, backoff on errors.
- Verify each ATS endpoint and response shape against its current public docs before coding against it. Do not rely on remembered URLs.
- Include a small seed script or CSV import for adding companies.
- Tests: fixture JSON per ATS, covering insert, unchanged re-poll, changed text, and closed posting.

## Stack (suggested, change freely)

- TypeScript on Node, `better-sqlite3` for the database, `vitest` for tests.
- LLM steps as small functions with a typed input and a typed, validated output (for example with `zod`), so each can be tested with fixtures.
- Keep secrets in `.env`, and keep `jobs.db`, generated resumes, and `.env` out of git.

## Targets (edit me)

- Role types: `swe`, `forward_deployed`, `solutions_engineer`, `implementation`
- Metros to compare: Seattle, Austin, remote
- Seniority: junior to mid
