-- Job search pipeline: SQLite schema
-- Usage: sqlite3 jobs.db < schema.sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

------------------------------------------------------------
-- 1. INGEST: companies and raw postings (written by plain code)
------------------------------------------------------------
CREATE TABLE companies (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  ats          TEXT CHECK (ats IN ('greenhouse','lever','ashby','other')),
  board_token  TEXT,              -- the slug used in the ATS board URL
  website      TEXT,
  industry     TEXT,
  watch        INTEGER NOT NULL DEFAULT 1,   -- 1 = keep polling this board
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE postings (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  external_id   TEXT NOT NULL,     -- the ATS's own job id
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  location_raw  TEXT,              -- exactly as the board states it
  raw_text      TEXT NOT NULL,     -- full description, HTML stripped
  content_hash  TEXT NOT NULL,     -- re-extract only when this changes
  posted_at     TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,              -- set when it disappears from the board
  UNIQUE (company_id, external_id)
);

-- Full-text search so an agent can pull a handful of postings by keyword
CREATE VIRTUAL TABLE postings_fts USING fts5(
  title, raw_text, content='postings', content_rowid='id'
);
CREATE TRIGGER postings_ai AFTER INSERT ON postings BEGIN
  INSERT INTO postings_fts(rowid, title, raw_text)
  VALUES (new.id, new.title, new.raw_text);
END;
CREATE TRIGGER postings_ad AFTER DELETE ON postings BEGIN
  INSERT INTO postings_fts(postings_fts, rowid, title, raw_text)
  VALUES ('delete', old.id, old.title, old.raw_text);
END;
CREATE TRIGGER postings_au AFTER UPDATE OF title, raw_text ON postings BEGIN
  INSERT INTO postings_fts(postings_fts, rowid, title, raw_text)
  VALUES ('delete', old.id, old.title, old.raw_text);
  INSERT INTO postings_fts(rowid, title, raw_text)
  VALUES (new.id, new.title, new.raw_text);
END;

------------------------------------------------------------
-- 2. EXTRACT: one structured row per posting (written by the LLM step)
------------------------------------------------------------
CREATE TABLE posting_extracts (
  posting_id    INTEGER PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
  role_type     TEXT,   -- e.g. swe, forward_deployed, solutions_engineer, implementation
  seniority     TEXT CHECK (seniority IN ('intern','junior','mid','senior','staff','unknown')),
  metro         TEXT,   -- normalized, e.g. 'Seattle, WA'
  remote_policy TEXT CHECK (remote_policy IN ('onsite','hybrid','remote','unknown')),
  min_years     INTEGER,
  salary_min    INTEGER,
  salary_max    INTEGER,
  summary       TEXT,   -- 2 to 3 sentences, cheap to load into context
  model         TEXT,   -- which model produced this row
  content_hash  TEXT NOT NULL,   -- hash of the text it was extracted from
  extracted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Canonical skills plus aliases, so "Node", "NodeJS" and "Node.js" count once
CREATE TABLE skills (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  category TEXT      -- language, framework, database, cloud, practice, soft
);
CREATE TABLE skill_aliases (
  alias    TEXT PRIMARY KEY COLLATE NOCASE,
  skill_id INTEGER NOT NULL REFERENCES skills(id)
);
CREATE TABLE posting_skills (
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skills(id),
  required   INTEGER NOT NULL DEFAULT 1,   -- 1 = required, 0 = nice to have
  PRIMARY KEY (posting_id, skill_id)
);

------------------------------------------------------------
-- 3. FACT BANK: your real experience, the only source for tailoring
------------------------------------------------------------
CREATE TABLE facts (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('job','project','education','cert','story')),
  context    TEXT NOT NULL,   -- employer or project name
  body       TEXT NOT NULL,   -- what you did, in full detail, with numbers
  start_date TEXT,
  end_date   TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE fact_skills (
  fact_id  INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  PRIMARY KEY (fact_id, skill_id)
);

------------------------------------------------------------
-- 4. TRIAGE and RESEARCH
------------------------------------------------------------
CREATE TABLE fit_scores (
  posting_id INTEGER PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rationale  TEXT,
  decision   TEXT CHECK (decision IN ('pursue','skip','maybe')),  -- yours, not the model's
  scored_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_notes (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind       TEXT CHECK (kind IN ('product','engineering','news','culture','people','other')),
  content    TEXT NOT NULL,   -- one self-contained fact or hook
  source_url TEXT NOT NULL,   -- no source, no note
  found_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

------------------------------------------------------------
-- 5. APPLICATIONS and their history
------------------------------------------------------------
CREATE TABLE applications (
  id             INTEGER PRIMARY KEY,
  posting_id     INTEGER NOT NULL UNIQUE REFERENCES postings(id),
  status         TEXT NOT NULL DEFAULT 'drafting'
                 CHECK (status IN ('drafting','applied','screen','interview','offer','rejected','withdrawn','ghosted')),
  resume_path    TEXT,
  cover_path     TEXT,
  applied_at     TEXT,
  next_follow_up TEXT,
  notes          TEXT
);
CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,   -- status_change, email, call, interview, follow_up
  detail         TEXT,
  occurred_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Which facts went into each tailored resume (lets the checker verify claims)
CREATE TABLE application_facts (
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  fact_id        INTEGER NOT NULL REFERENCES facts(id),
  PRIMARY KEY (application_id, fact_id)
);

CREATE INDEX idx_postings_open     ON postings(closed_at, first_seen_at);
CREATE INDEX idx_extracts_role     ON posting_extracts(role_type, metro);
CREATE INDEX idx_posting_skills_sk ON posting_skills(skill_id);
CREATE INDEX idx_research_company  ON research_notes(company_id);
CREATE INDEX idx_apps_status       ON applications(status, next_follow_up);

------------------------------------------------------------
-- 6. MARKET INTELLIGENCE: views the agent (or you) can query directly
------------------------------------------------------------
-- How often each skill shows up in open postings, per role type
CREATE VIEW skill_demand AS
SELECT e.role_type,
       s.name                AS skill,
       COUNT(*)              AS postings,
       SUM(ps.required)      AS required_in
FROM posting_skills ps
JOIN skills s            ON s.id = ps.skill_id
JOIN postings p          ON p.id = ps.posting_id AND p.closed_at IS NULL
JOIN posting_extracts e  ON e.posting_id = p.id
GROUP BY e.role_type, s.id;

-- In-demand skills with nothing in your fact bank backing them: the study list
CREATE VIEW skill_gaps AS
SELECT d.role_type, d.skill, d.postings, d.required_in
FROM skill_demand d
JOIN skills s ON s.name = d.skill
WHERE NOT EXISTS (
  SELECT 1 FROM fact_skills fs
  JOIN facts f ON f.id = fs.fact_id AND f.active = 1
  WHERE fs.skill_id = s.id
);

-- Open postings by metro and role type
CREATE VIEW metro_demand AS
SELECT e.metro, e.role_type, e.remote_policy,
       COUNT(*)                                   AS postings,
       CAST(AVG((e.salary_min + e.salary_max) / 2.0) AS INTEGER) AS avg_salary_mid
FROM posting_extracts e
JOIN postings p ON p.id = e.posting_id AND p.closed_at IS NULL
GROUP BY e.metro, e.role_type, e.remote_policy;

-- Postings whose text changed (or was never extracted): the extract step's work queue
CREATE VIEW extract_queue AS
SELECT p.id, p.title, p.company_id
FROM postings p
LEFT JOIN posting_extracts e ON e.posting_id = p.id
WHERE p.closed_at IS NULL
  AND (e.posting_id IS NULL OR e.content_hash <> p.content_hash);
