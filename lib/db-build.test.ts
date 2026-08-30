import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("production build uses an isolated in-memory database", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-relay-build-db-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousPhase = process.env.NEXT_PHASE;
  process.env.DATA_DIR = dataDir;
  process.env.NEXT_PHASE = "phase-production-build";

  const database = await import("./db");
  t.after(() => {
    database.db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previousPhase;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const databases = database.db.pragma("database_list") as Array<{
    name: string;
    file: string;
  }>;
  assert.equal(databases.find((item) => item.name === "main")?.file, "");
  assert.deepEqual(database.listLlms(), []);
  assert.equal(existsSync(join(dataDir, "relay.db")), false);
});
