import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Domain } from "../contracts.js";
import { ensureDir, readJsonFile } from "../fs-json.js";
import { siteDir } from "../paths.js";
import type { GraphCandidate } from "./post-capture.js";
import { resolveExplorationTopology } from "./topology.js";

const GRAPH_DB_SCHEMA_VERSION = 1;

export interface GraphDbImportResult {
  schemaVersion: 1;
  domain: Domain;
  dbPath: string;
  runDir: string;
  surfaceCount: number;
  actionCount: number;
}

export interface GraphDbSummary {
  schemaVersion: 1;
  domain: Domain;
  dbPath: string;
  runDir: string;
  surfaceCount: number;
  actionCount: number;
  safeNavigationActionCount: number;
}

export interface GraphDbSearchResult {
  schemaVersion: 1;
  domain: Domain;
  dbPath: string;
  query: string;
  results: Array<{
    surfaceId: string;
    surfaceType: string;
    title?: string;
    url: string;
    rank: number;
  }>;
}

export interface GraphDbPathResult {
  schemaVersion: 1;
  domain: Domain;
  dbPath: string;
  fromSurfaceId: string;
  toSurfaceId: string;
  found: boolean;
  steps: Array<{
    actionId: string;
    fromSurfaceId: string;
    toSurfaceId: string;
    label: string;
    href?: string;
  }>;
}

export interface GraphDbActionsResult {
  schemaVersion: 1;
  domain: Domain;
  dbPath: string;
  surfaceId: string;
  actions: Array<{
    actionId: string;
    label: string;
    actionKind: string;
    writeRisk: string;
    targetStatus: string;
    targetSurfaceId?: string;
    targetUrl?: string;
    href?: string;
    priority: number;
    canonicalSafe: boolean;
    selectors: GraphCandidate["edges"][number]["selectorCandidates"];
    warnings: string[];
    rawAction: GraphCandidate["edges"][number];
  }>;
}

export async function importExplorationRunToGraphDb(input: {
  domain: Domain;
  runDir: string;
  dbPath?: string;
}): Promise<GraphDbImportResult> {
  const dbPath = input.dbPath || defaultGraphDbPath(input.domain);
  const graphPath = path.join(input.runDir, "graph-candidate.json");
  const graph = await readJsonFile<GraphCandidate>(graphPath);
  if (!graph) throw new Error(`Missing graph-candidate.json in ${input.runDir}`);
  validateGraphCandidate(graph, graphPath);
  if (graph.domain !== input.domain) {
    throw new Error(
      `Graph candidate domain ${graph.domain} does not match ${input.domain}`,
    );
  }
  const topology = resolveExplorationTopology({
    domain: input.domain,
    runDir: input.runDir,
    graphPath,
    graph,
  });
  const candidatesById = new Map(graph.edges.map((edge) => [edge.edgeId, edge]));
  const canonicalSafeActionIds = new Set(
    topology.canonicalNavigationEdges.map((edge) => edge.edgeId),
  );
  const searchContent = new Map(
    await Promise.all(
      graph.nodes.map(async (surface) => [
        surface.nodeId,
        await surfaceSearchContent(graph, surface),
      ] as const),
    ),
  );

  await ensureDir(path.dirname(dbPath));
  const db = openGraphDbForImport(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM surface_search WHERE domain = ?").run(input.domain);
    db.prepare("DELETE FROM actions WHERE domain = ?").run(input.domain);
    db.prepare("DELETE FROM surfaces WHERE domain = ?").run(input.domain);
    db.prepare("DELETE FROM imports WHERE domain = ?").run(input.domain);
    db.prepare(`
      INSERT INTO imports (domain, run_dir, source_updated_at, imported_at)
      VALUES (?, ?, ?, ?)
    `).run(input.domain, input.runDir, graph.updatedAt, new Date().toISOString());
    const insertSurface = db.prepare(`
      INSERT INTO surfaces (
        id, domain, surface_type, url, url_shape, title, capture_id,
        surface_hash, surface_json_path, markdown_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const surface of graph.nodes) {
      insertSurface.run(
        surface.nodeId,
        input.domain,
        surface.surfaceType,
        surface.url,
        surface.urlShape,
        surface.title || null,
        surface.captureId,
        surface.surfaceHash,
        surface.evidence.surfaceJsonPath,
        surface.evidence.markdownPath,
      );
    }
    const insertAction = db.prepare(`
      INSERT INTO actions (
        id, domain, source_surface_id, target_surface_id, label, action_kind,
        write_risk, target_status, href, priority, to_url, is_canonical_safe,
        selector_json, warnings_json, nearby_text, action_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const action of topology.edges) {
      const candidate = candidatesById.get(action.edgeId);
      if (!candidate) continue;
      insertAction.run(
        action.edgeId,
        input.domain,
        action.fromNodeId,
        action.toNodeId || null,
        action.label,
        action.actionKind,
        action.writeRisk,
        action.targetStatus,
        action.href || null,
        action.priority,
        action.toUrl || null,
        canonicalSafeActionIds.has(action.edgeId) ? 1 : 0,
        JSON.stringify(candidate.selectorCandidates),
        JSON.stringify(action.warnings),
        candidate.evidence.context.nearbyText || null,
        JSON.stringify(candidate),
      );
    }
    const insertSearch = db.prepare(`
      INSERT INTO surface_search (
        domain, surface_id, title, url_shape, surface_type, content
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const surface of graph.nodes) {
      insertSearch.run(
        input.domain,
        surface.nodeId,
        surface.title || "",
        surface.urlShape,
        surface.surfaceType,
        searchContent.get(surface.nodeId) || "",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  return {
    schemaVersion: 1,
    domain: input.domain,
    dbPath,
    runDir: input.runDir,
    surfaceCount: graph.nodes.length,
    actionCount: graph.edges.length,
  };
}

export function searchGraphDb(input: {
  domain: Domain;
  query: string;
  dbPath?: string;
  limit?: number;
}): GraphDbSearchResult {
  const limit = positiveInteger(input.limit ?? 10, "limit");
  const query = toFtsQuery(input.query);
  const dbPath = input.dbPath || defaultGraphDbPath(input.domain);
  const db = openGraphDbForRead(dbPath);
  try {
    const rows = db.prepare(`
      SELECT
        s.id AS surface_id,
        s.surface_type,
        s.title,
        s.url,
        bm25(surface_search) AS rank
      FROM surface_search
      JOIN surfaces s
        ON s.domain = surface_search.domain
       AND s.id = surface_search.surface_id
      WHERE surface_search.domain = ?
        AND surface_search MATCH ?
      ORDER BY rank, s.id
      LIMIT ?
    `).all(input.domain, query, limit) as Array<{
      surface_id: string;
      surface_type: string;
      title: string | null;
      url: string;
      rank: number;
    }>;
    return {
      schemaVersion: 1,
      domain: input.domain,
      dbPath,
      query: input.query,
      results: rows.map((row) => ({
        surfaceId: row.surface_id,
        surfaceType: row.surface_type,
        title: row.title || undefined,
        url: row.url,
        rank: row.rank,
      })),
    };
  } finally {
    db.close();
  }
}

export function findGraphDbPath(input: {
  domain: Domain;
  fromSurfaceId: string;
  toSurfaceId: string;
  dbPath?: string;
  maxDepth?: number;
}): GraphDbPathResult {
  const maxDepth = positiveInteger(input.maxDepth ?? 20, "maxDepth");
  const dbPath = input.dbPath || defaultGraphDbPath(input.domain);
  const db = openGraphDbForRead(dbPath);
  try {
    requireGraphSurface(db, input.domain, input.fromSurfaceId);
    requireGraphSurface(db, input.domain, input.toSurfaceId);
    const rows = db.prepare(`
      SELECT id, source_surface_id, target_surface_id, label, href
      FROM actions
      WHERE domain = ?
        AND is_canonical_safe = 1
        AND target_surface_id IS NOT NULL
      ORDER BY priority DESC, id
    `).all(input.domain) as Array<{
      id: string;
      source_surface_id: string;
      target_surface_id: string;
      label: string;
      href: string | null;
    }>;
    const outgoing = new Map<string, typeof rows>();
    for (const row of rows) {
      const current = outgoing.get(row.source_surface_id) || [];
      current.push(row);
      outgoing.set(row.source_surface_id, current);
    }
    const queue: Array<{ surfaceId: string; steps: GraphDbPathResult["steps"] }> = [
      { surfaceId: input.fromSurfaceId, steps: [] },
    ];
    const visited = new Set([input.fromSurfaceId]);
    let steps: GraphDbPathResult["steps"] | undefined;
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      if (current.surfaceId === input.toSurfaceId) {
        steps = current.steps;
        break;
      }
      if (current.steps.length >= maxDepth) continue;
      for (const action of outgoing.get(current.surfaceId) || []) {
        if (visited.has(action.target_surface_id)) continue;
        visited.add(action.target_surface_id);
        queue.push({
          surfaceId: action.target_surface_id,
          steps: [
            ...current.steps,
            {
              actionId: action.id,
              fromSurfaceId: action.source_surface_id,
              toSurfaceId: action.target_surface_id,
              label: action.label,
              href: action.href || undefined,
            },
          ],
        });
      }
    }
    return {
      schemaVersion: 1,
      domain: input.domain,
      dbPath,
      fromSurfaceId: input.fromSurfaceId,
      toSurfaceId: input.toSurfaceId,
      found: steps !== undefined,
      steps: steps || [],
    };
  } finally {
    db.close();
  }
}

export function inspectGraphDbActions(input: {
  domain: Domain;
  surfaceId: string;
  dbPath?: string;
}): GraphDbActionsResult {
  const dbPath = input.dbPath || defaultGraphDbPath(input.domain);
  const db = openGraphDbForRead(dbPath);
  try {
    requireGraphSurface(db, input.domain, input.surfaceId);
    const rows = db.prepare(`
      SELECT
        a.id,
        a.label,
        a.action_kind,
        a.write_risk,
        a.target_status,
        a.target_surface_id,
        target.url AS target_url,
        a.href,
        a.priority,
        a.is_canonical_safe,
        a.selector_json,
        a.warnings_json,
        a.action_json
      FROM actions a
      LEFT JOIN surfaces target
        ON target.domain = a.domain
       AND target.id = a.target_surface_id
      WHERE a.domain = ?
        AND a.source_surface_id = ?
      ORDER BY a.priority DESC, a.id
    `).all(input.domain, input.surfaceId) as Array<{
      id: string;
      label: string;
      action_kind: string;
      write_risk: string;
      target_status: string;
      target_surface_id: string | null;
      target_url: string | null;
      href: string | null;
      priority: number;
      is_canonical_safe: number;
      selector_json: string;
      warnings_json: string;
      action_json: string;
    }>;
    return {
      schemaVersion: 1,
      domain: input.domain,
      dbPath,
      surfaceId: input.surfaceId,
      actions: rows.map((row) => ({
        actionId: row.id,
        label: row.label,
        actionKind: row.action_kind,
        writeRisk: row.write_risk,
        targetStatus: row.target_status,
        targetSurfaceId: row.target_surface_id || undefined,
        targetUrl: row.target_url || undefined,
        href: row.href || undefined,
        priority: row.priority,
        canonicalSafe: row.is_canonical_safe === 1,
        selectors: JSON.parse(row.selector_json) as GraphCandidate["edges"][number]["selectorCandidates"],
        warnings: JSON.parse(row.warnings_json) as string[],
        rawAction: JSON.parse(row.action_json) as GraphCandidate["edges"][number],
      })),
    };
  } finally {
    db.close();
  }
}

export function summarizeGraphDb(input: {
  domain: Domain;
  dbPath?: string;
}): GraphDbSummary {
  const dbPath = input.dbPath || defaultGraphDbPath(input.domain);
  const db = openGraphDbForRead(dbPath);
  try {
    const surfaceCount = countFor(
      db,
      "SELECT COUNT(*) AS count FROM surfaces WHERE domain = ?",
      input.domain,
    );
    const actionCount = countFor(
      db,
      "SELECT COUNT(*) AS count FROM actions WHERE domain = ?",
      input.domain,
    );
    const safeNavigationActionCount = countFor(
      db,
      `SELECT COUNT(*) AS count
       FROM actions
       WHERE domain = ?
         AND is_canonical_safe = 1`,
      input.domain,
    );
    const importRow = db.prepare(`
      SELECT run_dir
      FROM imports
      WHERE domain = ?
    `).get(input.domain) as { run_dir: string } | undefined;
    if (!importRow) throw new Error(`No graph import found for ${input.domain}`);
    return {
      schemaVersion: 1,
      domain: input.domain,
      dbPath,
      runDir: importRow.run_dir,
      surfaceCount,
      actionCount,
      safeNavigationActionCount,
    };
  } finally {
    db.close();
  }
}

export function defaultGraphDbPath(domain: Domain): string {
  return path.join(siteDir(domain), "site-graph.db");
}

function openGraphDbForImport(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  const schemaVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number | bigint })
      .user_version,
  );
  if (schemaVersion > GRAPH_DB_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Graph database schema version ${schemaVersion} is newer than supported version ${GRAPH_DB_SCHEMA_VERSION}`,
    );
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS imports (
      domain TEXT PRIMARY KEY,
      run_dir TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS surfaces (
      id TEXT NOT NULL,
      domain TEXT NOT NULL,
      surface_type TEXT NOT NULL,
      url TEXT NOT NULL,
      url_shape TEXT NOT NULL,
      title TEXT,
      capture_id TEXT NOT NULL,
      surface_hash TEXT NOT NULL,
      surface_json_path TEXT NOT NULL,
      markdown_path TEXT NOT NULL,
      PRIMARY KEY (domain, id)
    );
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT NOT NULL,
      domain TEXT NOT NULL,
      source_surface_id TEXT NOT NULL,
      target_surface_id TEXT,
      label TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      write_risk TEXT NOT NULL,
      target_status TEXT NOT NULL,
      href TEXT,
      priority INTEGER NOT NULL,
      to_url TEXT,
      is_canonical_safe INTEGER NOT NULL,
      selector_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      nearby_text TEXT,
      action_json TEXT NOT NULL,
      PRIMARY KEY (domain, id),
      FOREIGN KEY (domain, source_surface_id) REFERENCES surfaces(domain, id),
      FOREIGN KEY (domain, target_surface_id) REFERENCES surfaces(domain, id)
    );
    CREATE INDEX IF NOT EXISTS idx_actions_source
      ON actions(domain, source_surface_id);
    CREATE INDEX IF NOT EXISTS idx_actions_target
      ON actions(domain, target_surface_id);
    CREATE INDEX IF NOT EXISTS idx_actions_traversal
      ON actions(domain, is_canonical_safe, source_surface_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS surface_search USING fts5(
      domain UNINDEXED,
      surface_id UNINDEXED,
      title,
      url_shape,
      surface_type,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    PRAGMA user_version = ${GRAPH_DB_SCHEMA_VERSION};
  `);
  return db;
}

function openGraphDbForRead(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new Error(`Missing graph database: ${dbPath}. Run graph import first.`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

function countFor(db: DatabaseSync, sql: string, domain: Domain): number {
  const row = db.prepare(sql).get(domain) as { count: number | bigint };
  return Number(row.count);
}

function requireGraphSurface(
  db: DatabaseSync,
  domain: Domain,
  surfaceId: string,
): void {
  const surface = db.prepare(`
    SELECT id
    FROM surfaces
    WHERE domain = ? AND id = ?
  `).get(domain, surfaceId);
  if (!surface) throw new Error(`Unknown graph surface: ${surfaceId}`);
}

async function surfaceSearchContent(
  graph: GraphCandidate,
  surface: GraphCandidate["nodes"][number],
): Promise<string> {
  const actionText = graph.edges
    .filter((edge) => edge.fromNodeId === surface.nodeId)
    .flatMap((edge) => [
      edge.label,
      edge.controlName || "",
      edge.evidence.context.nearbyText || "",
    ])
    .join(" ");
  let markdown = "";
  try {
    markdown = await fs.readFile(surface.evidence.markdownPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return `${actionText} ${markdown}`.replace(/\s+/g, " ").trim().slice(0, 12_000);
}

function toFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '""'))
    .filter(Boolean);
  if (!terms.length) throw new Error("Graph search query cannot be empty");
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateGraphCandidate(graph: GraphCandidate, graphPath: string): void {
  if (graph.schemaVersion !== 1) {
    throw new Error(`Unsupported graph candidate schema in ${graphPath}`);
  }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error(`Invalid graph candidate arrays in ${graphPath}`);
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.nodeId || !node.url || !node.evidence?.markdownPath) {
      throw new Error(`Invalid graph candidate node in ${graphPath}`);
    }
    if (nodeIds.has(node.nodeId)) {
      throw new Error(`Duplicate graph candidate node: ${node.nodeId}`);
    }
    nodeIds.add(node.nodeId);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.edgeId || !edge.fromNodeId || !nodeIds.has(edge.fromNodeId)) {
      throw new Error(`Invalid graph candidate edge in ${graphPath}`);
    }
    if (edgeIds.has(edge.edgeId)) {
      throw new Error(`Duplicate graph candidate edge: ${edge.edgeId}`);
    }
    edgeIds.add(edge.edgeId);
  }
}
