import { openDb } from "../db.js";
import { ingestAll } from "../ingest/run.js";

const db = openDb();
try {
  const results = await ingestAll(db, { log: (line) => console.log(line) });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const failed = count("error");
  console.log(`\n${count("ok")} boards ok, ${count("skipped")} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  db.close();
}
