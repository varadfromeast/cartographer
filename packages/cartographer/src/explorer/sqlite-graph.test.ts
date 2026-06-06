import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  findGraphDbPath,
  importExplorationRunToGraphDb,
  inspectGraphDbActions,
  searchGraphDb,
  summarizeGraphDb,
} from "./sqlite-graph.js";
import type { GraphCandidate } from "./post-capture.js";

test("imports an exploration run into a queryable SQLite graph", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));

  const imported = await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: fixture.runDir,
    dbPath: fixture.dbPath,
  });
  const summary = summarizeGraphDb({
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
  });

  assert.deepEqual(imported, {
    schemaVersion: 1,
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
    runDir: fixture.runDir,
    surfaceCount: 3,
    actionCount: 4,
  });
  assert.deepEqual(summary, {
    schemaVersion: 1,
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
    runDir: fixture.runDir,
    surfaceCount: 3,
    actionCount: 4,
    safeNavigationActionCount: 2,
  });
});

test("searches imported surfaces through deterministic full-text search", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: fixture.runDir,
    dbPath: fixture.dbPath,
  });

  const results = searchGraphDb({
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
    query: "security",
  });

  assert.equal(results.results[0]?.surfaceId, "yc_security");
  assert.equal(results.results[0]?.title, "yc security");
  assert.equal(
    results.results[0]?.url,
    "https://www.ycombinator.com/companies/industry/security",
  );
});

test("finds a safe action path through imported surfaces", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: fixture.runDir,
    dbPath: fixture.dbPath,
  });

  const result = findGraphDbPath({
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
    fromSurfaceId: "yc_home",
    toSurfaceId: "yc_security",
  });

  assert.equal(result.found, true);
  assert.deepEqual(
    result.steps.map((step) => ({
      actionId: step.actionId,
      fromSurfaceId: step.fromSurfaceId,
      toSurfaceId: step.toSurfaceId,
    })),
    [
      {
        actionId: "e_companies",
        fromSurfaceId: "yc_home",
        toSurfaceId: "yc_companies",
      },
      {
        actionId: "e_security",
        fromSurfaceId: "yc_companies",
        toSurfaceId: "yc_security",
      },
    ],
  );
});

test("inspects imported actions with risk and binding evidence", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: fixture.runDir,
    dbPath: fixture.dbPath,
  });

  const result = inspectGraphDbActions({
    domain: "ycombinator.com",
    dbPath: fixture.dbPath,
    surfaceId: "yc_home",
  });

  const safe = result.actions.find(
    (action) => action.actionId === "e_companies",
  );
  const unsafe = result.actions.find(
    (action) => action.actionId === "e_unsafe_security",
  );
  assert.equal(safe?.targetSurfaceId, "yc_companies");
  assert.equal(safe?.targetStatus, "known");
  assert.equal(safe?.selectors[0]?.selector, 'role=link[name="Companies"]');
  assert.equal(safe?.rawAction.controlStableId, "stable-e_companies");
  assert.equal(unsafe?.writeRisk, "possible");
  assert.equal(unsafe?.targetStatus, "write_risk");
});

test("rejects invalid public query limits and traversal depths", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  await importExplorationRunToGraphDb({
    domain: "ycombinator.com",
    runDir: fixture.runDir,
    dbPath: fixture.dbPath,
  });

  assert.throws(
    () =>
      searchGraphDb({
        domain: "ycombinator.com",
        dbPath: fixture.dbPath,
        query: "security",
        limit: 0,
      }),
    /limit must be a positive integer/,
  );
  assert.throws(
    () =>
      findGraphDbPath({
        domain: "ycombinator.com",
        dbPath: fixture.dbPath,
        fromSurfaceId: "yc_home",
        toSurfaceId: "yc_security",
        maxDepth: 0,
      }),
    /maxDepth must be a positive integer/,
  );
});

test("refuses to import into a newer graph database schema", async (t) => {
  const fixture = await createGraphFixture();
  t.after(() => fs.rm(fixture.rootDir, { recursive: true, force: true }));
  const db = new DatabaseSync(fixture.dbPath);
  db.exec("PRAGMA user_version = 99");
  db.close();

  await assert.rejects(
    importExplorationRunToGraphDb({
      domain: "ycombinator.com",
      runDir: fixture.runDir,
      dbPath: fixture.dbPath,
    }),
    /schema version 99 is newer than supported version 1/,
  );
});

async function createGraphFixture(): Promise<{
  rootDir: string;
  runDir: string;
  dbPath: string;
}> {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cartographer-sqlite-"),
  );
  const runDir = path.join(rootDir, "run");
  await fs.mkdir(runDir, { recursive: true });
  const graph: GraphCandidate = {
    schemaVersion: 1,
    domain: "ycombinator.com",
    updatedAt: "2026-06-06T00:00:00.000Z",
    nodes: [
      node("yc_home", "yc_home", "https://www.ycombinator.com/"),
      node(
        "yc_companies",
        "yc_companies",
        "https://www.ycombinator.com/companies",
      ),
      node(
        "yc_security",
        "yc_content_page",
        "https://www.ycombinator.com/companies/industry/security",
      ),
    ],
    edges: [
      edge("e_companies", "yc_home", "Companies", "/companies"),
      edge(
        "e_security",
        "yc_companies",
        "Security",
        "/companies/industry/security",
      ),
      {
        ...edge("e_search", "yc_home", "Search", undefined, "input"),
        writeRisk: "possible",
      },
      {
        ...edge(
          "e_unsafe_security",
          "yc_home",
          "Unsafe shortcut",
          "/companies/industry/security",
        ),
        writeRisk: "possible",
      },
    ],
  };
  await fs.writeFile(
    path.join(runDir, "graph-candidate.json"),
    `${JSON.stringify(graph, null, 2)}\n`,
  );
  return { rootDir, runDir, dbPath: path.join(rootDir, "site-graph.db") };
}

function node(
  nodeId: GraphCandidate["nodes"][number]["nodeId"],
  surfaceType: GraphCandidate["nodes"][number]["surfaceType"],
  url: string,
): GraphCandidate["nodes"][number] {
  return {
    nodeId,
    surfaceType,
    url,
    urlShape: url.replace(/^https?:\/\//, ""),
    title: nodeId.replaceAll("_", " "),
    captureId: `capture-${nodeId}`,
    surfaceHash: `hash-${nodeId}`,
    evidence: {
      surfaceJsonPath: `/tmp/${nodeId}/surface.json`,
      markdownPath: `/tmp/${nodeId}/surface.md`,
      screenshotPath: `/tmp/${nodeId}/screenshot.png`,
    },
  };
}

function edge(
  edgeId: string,
  fromNodeId: string,
  label: string,
  href?: string,
  actionKind: "navigate" | "input" = "navigate",
): GraphCandidate["edges"][number] {
  return {
    edgeId,
    label,
    fromNodeId,
    actionKind,
    controlRef: `control-${edgeId}`,
    controlStableId: `stable-${edgeId}`,
    href,
    toHint: href || label,
    priority: 1,
    writeRisk: "none",
    warnings: [],
    selectorCandidates: [
      {
        selector: `role=link[name="${label}"]`,
        kind: "role",
        stability: "strong",
        reason: "fixture",
      },
    ],
    evidence: {
      rect: { x: 0, y: 0, width: 10, height: 10 },
      context: {},
    },
  };
}
