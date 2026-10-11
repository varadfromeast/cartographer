import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findGraphDbPath,
  importExplorationRunToGraphDb,
  inspectGraphDbActions,
  searchGraphDb,
  summarizeGraphDb,
} from "./sqlite-graph.js";

const YC_SOAK_RUN =
  "/Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31";

test("real YC graph can be imported, searched, traversed, and inspected", async (t) => {
  try {
    await fs.access(path.join(YC_SOAK_RUN, "graph-candidate.json"));
  } catch {
    t.skip(`Missing local YC proving run: ${YC_SOAK_RUN}`);
    return;
  }
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cartographer-yc-mvp-"));
  const dbPath = path.join(rootDir, "site-graph.db");
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: YC_SOAK_RUN,
    dbPath,
  });
  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: YC_SOAK_RUN,
    dbPath,
  });

  const summary = summarizeGraphDb({ domain: "ycombinator.com", dbPath });
  assert.equal(summary.surfaceCount, 193);
  assert.equal(summary.actionCount, 7550);

  const search = searchGraphDb({
    domain: "ycombinator.com",
    dbPath,
    query: "security startups",
    limit: 5,
  });
  assert(
    search.results.some(
      (result) =>
        result.surfaceId ===
        "yc_www-ycombinator-com-companies-industry-security",
    ),
  );

  const pathResult = findGraphDbPath({
    domain: "ycombinator.com",
    dbPath,
    fromSurfaceId: "yc_home",
    toSurfaceId: "yc_www-ycombinator-com-companies-industry-security",
  });
  assert.equal(pathResult.found, true);
  assert.deepEqual(
    pathResult.steps.map((step) => step.actionId),
    ["e_551ee4cc9a52", "e_eb2e4638d57d", "e_efed469706c7"],
  );
  assert.equal(
    findGraphDbPath({
      domain: "ycombinator.com",
      dbPath,
      fromSurfaceId: "yc_home",
      toSurfaceId: "yc_www-ycombinator-com-companies-industry-security",
      maxDepth: 2,
    }).found,
    false,
  );
  assert.equal(
    searchGraphDb({
      domain: "ycombinator.com",
      dbPath,
      query: 'security "startups',
    }).results.length > 0,
    true,
  );

  const actions = inspectGraphDbActions({
    domain: "ycombinator.com",
    dbPath,
    surfaceId: "yc_home",
  });
  const about = actions.actions.find(
    (action) => action.actionId === "e_d20be7499f11",
  );
  assert.equal(about?.targetSurfaceId, "yc_about");
  assert.equal(about?.rawAction.controlStableId, "c_5dc010e9aeea");
});
