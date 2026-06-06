import path from "node:path";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import type { Domain } from "../contracts.js";
import { readJsonFile, writeJsonFile } from "../fs-json.js";
import { siteDir } from "../paths.js";
import { shapeUrl } from "../state-identity.js";
import type { CandidateEdge, GraphCandidate } from "./post-capture.js";
import { getExplorationSiteAdapter } from "./site-adapter.js";

export type ExplorationTopologyTargetStatus =
  | "known"
  | "self"
  | "uncaptured"
  | "external"
  | "write_risk"
  | "blocked"
  | "unresolved";

export interface ExplorationTopologyNode {
  nodeId: string;
  surfaceType: string;
  url: string;
  urlShape: string;
  title?: string;
  captureId: string;
  outgoingEdgeCount: number;
  incomingKnownEdgeCount: number;
  safeNavigationEdgeCount: number;
  writeRiskEdgeCount: number;
  selfLoopEdgeCount: number;
  uncapturedNavigationEdgeCount: number;
}

export interface ExplorationTopologyEdge {
  edgeId: string;
  fromNodeId: string;
  label: string;
  actionKind: CandidateEdge["actionKind"];
  writeRisk: CandidateEdge["writeRisk"];
  href?: string;
  toUrl?: string;
  toUrlShape?: string;
  toNodeId?: string;
  targetStatus: ExplorationTopologyTargetStatus;
  priority: number;
  warnings: string[];
}

export interface ExplorationTopologyDuplicatePair {
  fromNodeId: string;
  toNodeId: string;
  canonicalEdgeId: string;
  count: number;
  edgeIds: string[];
  labels: string[];
}

export interface ExplorationTopologyCanonicalEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  href?: string;
  toUrl: string;
  priority: number;
  duplicateAlternativeEdgeIds: string[];
}

export interface ExplorationTopologyArtifact {
  schemaVersion: 1;
  method: "resolveExplorationTopology";
  domain: Domain;
  runDir: string;
  graphPath: string;
  generatedAt: string;
  rootNodeId?: string;
  summary: {
    nodeCount: number;
    edgeCount: number;
    knownNavigationEdgeCount: number;
    selfLoopEdgeCount: number;
    uncapturedNavigationEdgeCount: number;
    externalNavigationEdgeCount: number;
    writeRiskEdgeCount: number;
    blockedActionEdgeCount: number;
    unresolvedEdgeCount: number;
    duplicateResolvedPairCount: number;
    reachableNodeCount: number;
    unreachableNodeCount: number;
    maxOutgoingEdgeCount: number;
  };
  statusCounts: Record<ExplorationTopologyTargetStatus, number>;
  nodes: ExplorationTopologyNode[];
  edges: ExplorationTopologyEdge[];
  canonicalNavigationEdges: ExplorationTopologyCanonicalEdge[];
  duplicateResolvedPairs: ExplorationTopologyDuplicatePair[];
  unreachableNodeIds: string[];
  artifactPath?: string;
}

export interface ExplorationTopologyQualityFinding {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
}

export interface ExplorationTopologyQuality {
  ok: boolean;
  findings: ExplorationTopologyQualityFinding[];
  thresholds: {
    maxUncapturedSafeNavigationRatio: number;
    maxSelfLoopSafeNavigationRatio: number;
    maxDuplicateResolvedPairRatio: number;
  };
}

export async function createExplorationTopologyArtifact(input: {
  domain: Domain;
  runDir?: string;
  writeArtifact?: boolean;
}): Promise<ExplorationTopologyArtifact> {
  const { runDir, graph, graphPath } = await loadExplorationGraphCandidate({
    domain: input.domain,
    runDir: input.runDir,
  });
  const topology = resolveExplorationTopology({
    domain: input.domain,
    runDir,
    graphPath,
    graph,
  });
  if (input.writeArtifact) {
    topology.artifactPath = path.join(runDir, "graph-topology.json");
    await writeJsonFile(topology.artifactPath, topology);
  }
  return topology;
}

export async function loadExplorationGraphCandidate(input: {
  domain: Domain;
  runDir?: string;
}): Promise<{ runDir: string; graphPath: string; graph: GraphCandidate }> {
  const runDir = input.runDir || (await latestExplorationRunDir(input.domain));
  const graphPath = path.join(runDir, "graph-candidate.json");
  const graph = await readJsonFile<GraphCandidate>(graphPath);
  if (!graph) throw new Error(`Missing graph-candidate.json in ${runDir}`);
  return { runDir, graphPath, graph };
}

export function resolveExplorationTopology(input: {
  domain: Domain;
  runDir: string;
  graphPath: string;
  graph: GraphCandidate;
  rootNodeId?: string;
}): ExplorationTopologyArtifact {
  const rootNodeId = input.rootNodeId || input.graph.nodes[0]?.nodeId;
  const edges = input.graph.edges.map((edge) =>
    resolveExplorationEdgeTarget({
      domain: input.domain,
      graph: input.graph,
      edge,
    }),
  );
  const statusCounts = emptyStatusCounts();
  for (const edge of edges) statusCounts[edge.targetStatus] += 1;

  const canonicalNavigationEdges = canonicalNavigationEdgesFor(edges);
  const duplicateResolvedPairs = duplicatePairsFor(
    edges,
    canonicalNavigationEdges,
  );
  const reachableNodeIds = reachableNodesFor({
    rootNodeId,
    edges: canonicalNavigationEdges,
  });
  const unreachableNodeIds = input.graph.nodes
    .map((node) => node.nodeId)
    .filter((nodeId) => !reachableNodeIds.has(nodeId));
  const nodes = input.graph.nodes.map((node) => {
    const outgoing = edges.filter((edge) => edge.fromNodeId === node.nodeId);
    const incoming = edges.filter(
      (edge) =>
        edge.toNodeId === node.nodeId &&
        (edge.targetStatus === "known" || edge.targetStatus === "self"),
    );
    return {
      nodeId: node.nodeId,
      surfaceType: node.surfaceType,
      url: node.url,
      urlShape: node.urlShape,
      title: node.title,
      captureId: node.captureId,
      outgoingEdgeCount: outgoing.length,
      incomingKnownEdgeCount: incoming.length,
      safeNavigationEdgeCount: outgoing.filter(
        (edge) =>
          edge.actionKind === "navigate" &&
          edge.writeRisk === "none" &&
          (edge.targetStatus === "known" || edge.targetStatus === "self"),
      ).length,
      writeRiskEdgeCount: outgoing.filter((edge) => edge.writeRisk !== "none")
        .length,
      selfLoopEdgeCount: outgoing.filter((edge) => edge.targetStatus === "self")
        .length,
      uncapturedNavigationEdgeCount: outgoing.filter(
        (edge) => edge.targetStatus === "uncaptured",
      ).length,
    };
  });

  return {
    schemaVersion: 1,
    method: "resolveExplorationTopology",
    domain: input.domain,
    runDir: input.runDir,
    graphPath: input.graphPath,
    generatedAt: new Date().toISOString(),
    rootNodeId,
    summary: {
      nodeCount: input.graph.nodes.length,
      edgeCount: input.graph.edges.length,
      knownNavigationEdgeCount: statusCounts.known,
      selfLoopEdgeCount: statusCounts.self,
      uncapturedNavigationEdgeCount: statusCounts.uncaptured,
      externalNavigationEdgeCount: statusCounts.external,
      writeRiskEdgeCount: statusCounts.write_risk,
      blockedActionEdgeCount: statusCounts.blocked,
      unresolvedEdgeCount: statusCounts.unresolved,
      duplicateResolvedPairCount: duplicateResolvedPairs.length,
      reachableNodeCount: reachableNodeIds.size,
      unreachableNodeCount: unreachableNodeIds.length,
      maxOutgoingEdgeCount: nodes.reduce(
        (max, node) => Math.max(max, node.outgoingEdgeCount),
        0,
      ),
    },
    statusCounts,
    nodes,
    edges,
    canonicalNavigationEdges,
    duplicateResolvedPairs,
    unreachableNodeIds,
  };
}

export function resolveExplorationEdgeTarget(input: {
  domain: Domain;
  graph: GraphCandidate;
  edge: CandidateEdge;
}): ExplorationTopologyEdge {
  const base = {
    edgeId: input.edge.edgeId,
    fromNodeId: input.edge.fromNodeId,
    label: input.edge.label,
    actionKind: input.edge.actionKind,
    writeRisk: input.edge.writeRisk,
    href: input.edge.href,
    priority: input.edge.priority,
    warnings: input.edge.warnings,
  };
  const fromNode = input.graph.nodes.find(
    (node) => node.nodeId === input.edge.fromNodeId,
  );
  const target = fromNode
    ? targetUrlForEdge(input.edge, fromNode.url)
    : { status: "unresolved" as const };
  const toUrl = target.status === "ok" ? target.toUrl : undefined;
  const toNodeId =
    toUrl && findExplorationNodeForUrl(input.graph, toUrl)?.nodeId;
  const targetStatus = targetStatusFor({
    domain: input.domain,
    edge: input.edge,
    fromNodeId: input.edge.fromNodeId,
    target,
    toNodeId,
  });
  return {
    ...base,
    toUrl,
    toUrlShape: toUrl ? shapeUrl(toUrl) : undefined,
    toNodeId,
    targetStatus,
  };
}

export function findExplorationNodeForUrl(
  graph: GraphCandidate,
  url: string,
): GraphCandidate["nodes"][number] | undefined {
  const exact = graph.nodes.find((node) =>
    equivalentExplorationUrl(node.url, url),
  );
  if (exact) return exact;
  const shape = shapeUrl(url);
  const shapeMatches = graph.nodes.filter((node) => node.urlShape === shape);
  return shapeMatches.length === 1 ? shapeMatches[0] : undefined;
}

export function equivalentExplorationUrl(
  expected: string,
  actual: string,
): boolean {
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  expectedUrl.hash = "";
  actualUrl.hash = "";
  expectedUrl.pathname = normalizedExplorationPathname(expectedUrl.pathname);
  actualUrl.pathname = normalizedExplorationPathname(actualUrl.pathname);
  return expectedUrl.toString() === actualUrl.toString();
}

function normalizedExplorationPathname(pathname: string): string {
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

export function evaluateExplorationTopologyQuality(
  topology: ExplorationTopologyArtifact,
  thresholds: Partial<ExplorationTopologyQuality["thresholds"]> = {},
): ExplorationTopologyQuality {
  const resolvedThresholds = {
    maxUncapturedSafeNavigationRatio: 0.35,
    maxSelfLoopSafeNavigationRatio: 0.08,
    maxDuplicateResolvedPairRatio: 0.2,
    ...thresholds,
  };
  const findings: ExplorationTopologyQualityFinding[] = [];
  if (!topology.summary.nodeCount) {
    findings.push({
      level: "error",
      code: "topology_empty_graph",
      message: "Exploration topology has no nodes.",
    });
  }
  if (topology.rootNodeId && topology.summary.unreachableNodeCount > 0) {
    findings.push({
      level: "warning",
      code: "topology_unreachable_nodes",
      message: `${topology.summary.unreachableNodeCount} nodes are not reachable from ${topology.rootNodeId} through known safe navigation edges.`,
      nodeIds: topology.unreachableNodeIds.slice(0, 20),
    });
  }

  const safeNavigationCount =
    topology.summary.knownNavigationEdgeCount +
    topology.summary.selfLoopEdgeCount +
    topology.summary.uncapturedNavigationEdgeCount +
    topology.summary.externalNavigationEdgeCount +
    topology.summary.unresolvedEdgeCount;
  const uncapturedRatio = ratio(
    topology.summary.uncapturedNavigationEdgeCount,
    safeNavigationCount,
  );
  if (uncapturedRatio > resolvedThresholds.maxUncapturedSafeNavigationRatio) {
    findings.push({
      level: "warning",
      code: "topology_high_uncaptured_navigation_ratio",
      message: `${formatPercent(uncapturedRatio)} of safe navigation edges point to same-domain surfaces not captured in this run.`,
      edgeIds: topology.edges
        .filter((edge) => edge.targetStatus === "uncaptured")
        .slice(0, 20)
        .map((edge) => edge.edgeId),
    });
  }

  const selfLoopRatio = ratio(
    topology.summary.selfLoopEdgeCount,
    safeNavigationCount,
  );
  if (selfLoopRatio > resolvedThresholds.maxSelfLoopSafeNavigationRatio) {
    findings.push({
      level: "warning",
      code: "topology_high_self_loop_ratio",
      message: `${formatPercent(selfLoopRatio)} of safe navigation edges resolve back to their source node.`,
      edgeIds: topology.edges
        .filter((edge) => edge.targetStatus === "self")
        .slice(0, 20)
        .map((edge) => edge.edgeId),
    });
  }

  const duplicateRatio = ratio(
    topology.summary.duplicateResolvedPairCount,
    Math.max(1, topology.summary.nodeCount),
  );
  if (duplicateRatio > resolvedThresholds.maxDuplicateResolvedPairRatio) {
    findings.push({
      level: "warning",
      code: "topology_duplicate_resolved_pairs",
      message: `${topology.summary.duplicateResolvedPairCount} resolved node pairs have multiple candidate edges.`,
      edgeIds: topology.duplicateResolvedPairs
        .slice(0, 10)
        .flatMap((pair) => pair.edgeIds.slice(0, 3)),
    });
  }

  if (topology.summary.writeRiskEdgeCount > 0) {
    findings.push({
      level: "info",
      code: "topology_write_risk_edges_present",
      message: `${topology.summary.writeRiskEdgeCount} candidate edges carry write-risk metadata and are excluded from safe topology reachability.`,
      edgeIds: topology.edges
        .filter((edge) => edge.targetStatus === "write_risk")
        .slice(0, 20)
        .map((edge) => edge.edgeId),
    });
  }

  return {
    ok: !findings.some((finding) => finding.level === "error"),
    findings,
    thresholds: resolvedThresholds,
  };
}

export async function latestExplorationRunDir(domain: Domain): Promise<string> {
  const runsDir = path.join(siteDir(domain), "exploration-runs");
  const entries = await fs
    .readdir(runsDir, { withFileTypes: true })
    .catch((): Dirent[] => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
  const latest = dirs.at(-1);
  if (!latest) throw new Error(`No exploration runs for ${domain}`);
  return latest;
}

function targetUrlForEdge(
  edge: CandidateEdge,
  baseUrl: string,
): { status: "ok"; toUrl: string } | { status: "unresolved" } {
  if (!edge.href) return { status: "unresolved" };
  try {
    const url = new URL(edge.href, baseUrl);
    url.hash = "";
    return { status: "ok", toUrl: url.toString() };
  } catch {
    return { status: "unresolved" };
  }
}

function targetStatusFor(input: {
  domain: Domain;
  edge: CandidateEdge;
  fromNodeId: string;
  target: { status: "ok"; toUrl: string } | { status: "unresolved" };
  toNodeId?: string;
}): ExplorationTopologyTargetStatus {
  if (input.edge.writeRisk !== "none") return "write_risk";
  if (input.edge.actionKind !== "navigate") return "blocked";
  if (input.target.status === "unresolved") return "unresolved";
  if (
    !sameDomain(input.domain, new URL(input.target.toUrl).hostname) ||
    !getExplorationSiteAdapter(input.domain).isCrawlableUrl(input.target.toUrl)
  ) {
    return "external";
  }
  if (!input.toNodeId) return "uncaptured";
  if (input.toNodeId === input.fromNodeId) return "self";
  return "known";
}

function sameDomain(domain: Domain, hostname: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function emptyStatusCounts(): Record<ExplorationTopologyTargetStatus, number> {
  return {
    known: 0,
    self: 0,
    uncaptured: 0,
    external: 0,
    write_risk: 0,
    blocked: 0,
    unresolved: 0,
  };
}

export function canonicalNavigationEdgesFor(
  edges: ExplorationTopologyEdge[],
): ExplorationTopologyCanonicalEdge[] {
  const byPair = new Map<
    string,
    {
      fromNodeId: string;
      toNodeId: string;
      edges: ExplorationTopologyEdge[];
    }
  >();
  for (const edge of edges) {
    if (
      edge.actionKind !== "navigate" ||
      edge.writeRisk !== "none" ||
      !edge.toNodeId ||
      (edge.targetStatus !== "known" && edge.targetStatus !== "self")
    ) {
      continue;
    }
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    const current = byPair.get(key) || {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edges: [],
    };
    current.edges.push(edge);
    byPair.set(key, current);
  }
  return [...byPair.values()]
    .map((pair) => ({
      fromNodeId: pair.fromNodeId,
      toNodeId: pair.toNodeId,
      canonical: pair.edges.slice().sort(compareCanonicalEdges)[0],
      alternatives: pair.edges.slice().sort(compareCanonicalEdges).slice(1),
    }))
    .map((pair) => ({
      edgeId: pair.canonical.edgeId,
      fromNodeId: pair.fromNodeId,
      toNodeId: pair.toNodeId,
      label: pair.canonical.label,
      href: pair.canonical.href,
      toUrl: pair.canonical.toUrl || "",
      priority: pair.canonical.priority,
      duplicateAlternativeEdgeIds: pair.alternatives.map((edge) => edge.edgeId),
    }))
    .sort(
      (a, b) =>
        a.fromNodeId.localeCompare(b.fromNodeId) ||
        a.toNodeId.localeCompare(b.toNodeId) ||
        b.priority - a.priority ||
        a.edgeId.localeCompare(b.edgeId),
    );
}

function duplicatePairsFor(
  edges: ExplorationTopologyEdge[],
  canonicalEdges: ExplorationTopologyCanonicalEdge[],
): ExplorationTopologyDuplicatePair[] {
  const canonicalByPair = new Map(
    canonicalEdges.map((edge) => [
      `${edge.fromNodeId}\u0000${edge.toNodeId}`,
      edge.edgeId,
    ]),
  );
  const byPair = new Map<
    string,
    {
      fromNodeId: string;
      toNodeId: string;
      edgeIds: string[];
      labels: Set<string>;
    }
  >();
  for (const edge of edges) {
    if (
      edge.actionKind !== "navigate" ||
      edge.writeRisk !== "none" ||
      !edge.toNodeId ||
      (edge.targetStatus !== "known" && edge.targetStatus !== "self")
    ) {
      continue;
    }
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    const current = byPair.get(key) || {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edgeIds: [],
      labels: new Set<string>(),
    };
    current.edgeIds.push(edge.edgeId);
    current.labels.add(edge.label);
    byPair.set(key, current);
  }
  return [...byPair.entries()]
    .filter(([, pair]) => pair.edgeIds.length > 1)
    .map(([key, pair]) => ({
      fromNodeId: pair.fromNodeId,
      toNodeId: pair.toNodeId,
      canonicalEdgeId: canonicalByPair.get(key) || pair.edgeIds[0],
      count: pair.edgeIds.length,
      edgeIds: pair.edgeIds,
      labels: [...pair.labels].sort(),
    }))
    .sort(
      (a, b) => b.count - a.count || a.fromNodeId.localeCompare(b.fromNodeId),
    );
}

function reachableNodesFor(input: {
  rootNodeId?: string;
  edges: ExplorationTopologyCanonicalEdge[];
}): Set<string> {
  const reachable = new Set<string>();
  if (!input.rootNodeId) return reachable;
  reachable.add(input.rootNodeId);
  const queue = [input.rootNodeId];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of input.edges) {
      if (edge.fromNodeId !== current) continue;
      if (reachable.has(edge.toNodeId)) continue;
      reachable.add(edge.toNodeId);
      queue.push(edge.toNodeId);
    }
  }
  return reachable;
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function compareCanonicalEdges(
  a: ExplorationTopologyEdge,
  b: ExplorationTopologyEdge,
): number {
  return (
    b.priority - a.priority ||
    normalizedLabel(a.label).length - normalizedLabel(b.label).length ||
    normalizedLabel(a.label).localeCompare(normalizedLabel(b.label)) ||
    a.edgeId.localeCompare(b.edgeId)
  );
}

function normalizedLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
