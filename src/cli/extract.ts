import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDb } from "../db.js";
import { createClaudeExtractor } from "../extract/claude.js";
import { runExtract } from "../extract/run.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

const db = openDb();
try {
  const result = await runExtract(db, createClaudeExtractor(), {
    limit: values.limit ? Number(values.limit) : undefined,
    concurrency: Number(values.concurrency),
    log: (line) => console.log(line),
  });
  const left = (db.prepare("SELECT COUNT(*) AS n FROM extract_queue").get() as { n: number }).n;
  console.log(`\n${result.extracted} extracted, ${result.failed.length} failed, ${left} still queued`);
  if (result.failed.length > 0) process.exitCode = 1;
} finally {
  db.close();
}
