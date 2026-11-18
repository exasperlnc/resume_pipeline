import { openDb, DEFAULT_DB_PATH } from "../db.js";

openDb().close();
console.log(`Database ready at ${DEFAULT_DB_PATH}`);
