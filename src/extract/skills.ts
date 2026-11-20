import type { DB } from "../db.js";
import { VOCABULARY } from "./vocabulary.js";

/**
 * Loose match key so spelling variants collapse: "Node.js", "NodeJS" and
 * "node js" all become "nodejs". Symbols that change meaning are kept:
 * "C++" and "C#" stay distinct from "C".
 */
export function skillKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s._\-/]+/g, "")
    .trim();
}

/** Insert the starter vocabulary and its aliases. Safe to run repeatedly. */
export function seedSkills(db: DB): void {
  const insertSkill = db.prepare("INSERT OR IGNORE INTO skills (name, category) VALUES (?, ?)");
  const skillId = db.prepare<[string], { id: number }>("SELECT id FROM skills WHERE name = ?");
  const insertAlias = db.prepare("INSERT OR IGNORE INTO skill_aliases (alias, skill_id) VALUES (?, ?)");
  db.transaction(() => {
    for (const [name, category, aliases] of VOCABULARY) {
      insertSkill.run(name, category);
      const { id } = skillId.get(name)!;
      for (const a of [name, ...aliases]) {
        insertAlias.run(a, id);
        insertAlias.run(skillKey(a), id);
      }
    }
  })();
}

/**
 * Resolve a skill name to a skills.id through skill_aliases, creating the
 * skill (and its aliases) when nothing matches. Must run inside a transaction.
 */
export function createSkillResolver(db: DB) {
  const byAlias = db.prepare<[string], { skill_id: number }>("SELECT skill_id FROM skill_aliases WHERE alias = ?");
  const byName = db.prepare<[string], { id: number }>("SELECT id FROM skills WHERE name = ? COLLATE NOCASE");
  const insertSkill = db.prepare("INSERT INTO skills (name, category) VALUES (?, ?)");
  const insertAlias = db.prepare("INSERT OR IGNORE INTO skill_aliases (alias, skill_id) VALUES (?, ?)");

  return (name: string, category: string | null): number => {
    const key = skillKey(name);
    const hit = byAlias.get(name) ?? byAlias.get(key);
    if (hit) return hit.skill_id;
    const existing = byName.get(name);
    const id = existing ? existing.id : Number(insertSkill.run(name, category).lastInsertRowid);
    insertAlias.run(name, id);
    if (key) insertAlias.run(key, id);
    return id;
  };
}
