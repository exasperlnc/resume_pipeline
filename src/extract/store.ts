import type { DB } from "../db.js";
import type { ExtractOutput } from "./schema.js";
import { createSkillResolver } from "./skills.js";

/**
 * Write one posting's extract and replace its skills, in one transaction.
 * content_hash is the hash of the text that was sent to the model; if the
 * posting changed in the meantime the row stays in extract_queue.
 */
export function saveExtract(
  db: DB,
  postingId: number,
  contentHash: string,
  output: ExtractOutput,
  model: string,
  now: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO posting_extracts (posting_id, role_type, seniority, metro, remote_policy, min_years,
                                   salary_min, salary_max, summary, model, content_hash, extracted_at)
     VALUES (@postingId, @role_type, @seniority, @metro, @remote_policy, @min_years,
             @salary_min, @salary_max, @summary, @model, @contentHash, @now)
     ON CONFLICT(posting_id) DO UPDATE SET
       role_type = excluded.role_type, seniority = excluded.seniority, metro = excluded.metro,
       remote_policy = excluded.remote_policy, min_years = excluded.min_years,
       salary_min = excluded.salary_min, salary_max = excluded.salary_max,
       summary = excluded.summary, model = excluded.model,
       content_hash = excluded.content_hash, extracted_at = excluded.extracted_at`,
  );
  const clearSkills = db.prepare("DELETE FROM posting_skills WHERE posting_id = ?");
  // If the model lists a skill twice (or two aliases of one skill), required wins.
  const addSkill = db.prepare(
    `INSERT INTO posting_skills (posting_id, skill_id, required) VALUES (?, ?, ?)
     ON CONFLICT(posting_id, skill_id) DO UPDATE SET required = MAX(required, excluded.required)`,
  );

  db.transaction(() => {
    const { skills, ...fields } = output;
    upsert.run({ ...fields, postingId, contentHash, model, now });
    clearSkills.run(postingId);
    const resolve = createSkillResolver(db);
    for (const s of skills) addSkill.run(postingId, resolve(s.name, s.category), s.required ? 1 : 0);
  })();
}
