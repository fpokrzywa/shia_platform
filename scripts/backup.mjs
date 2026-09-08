import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  postgresEnvironment,
  runPostgresTool,
  sourceUrl,
} from "./postgres-ops.mjs";

const output = process.argv[2];
if (!output)
  throw new Error("Usage: node scripts/backup.mjs <new-backup-file>");
try {
  await access(output);
  throw new Error("Backup destination already exists");
} catch (error) {
  if (error?.message === "Backup destination already exists") throw error;
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
const url = sourceUrl();
const destination = path.resolve(output);
const partial = `${destination}.partial`;
try {
  await runPostgresTool(
    "pg_dump",
    ["--format=plain", "--no-owner", "--no-privileges", "--file", partial],
    postgresEnvironment(url),
  );
  const sql = await readFile(partial, "utf8");
  await writeFile(
    partial,
    sql.replace(/^SET transaction_timeout = 0;\r?\n/m, ""),
    "utf8",
  );
  await rename(partial, destination);
} catch (error) {
  await rm(partial, { force: true });
  throw error;
}
console.log(`Backup created: ${path.resolve(output)}`);
