import { readFileSync } from "node:fs";
import { openDb } from "../db.js";
import { parseCompaniesCsv, upsertCompanies } from "../seed.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run seed -- <companies.csv>");
  process.exit(2);
}
const rows = parseCompaniesCsv(readFileSync(file, "utf8"));
const db = openDb();
try {
  const { inserted, updated } = upsertCompanies(db, rows);
  console.log(`${inserted} companies added, ${updated} updated`);
} finally {
  db.close();
}
