import fs from "node:fs/promises";
import path from "node:path";
import type { Domain } from "../contracts.js";
import { createExplorationTopologyArtifact } from "./topology.js";
import type {
  ExplorationTopologyArtifact,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
} from "./topology.js";

export interface ExplorationVisualizationResult {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  topologyPath: string;
  htmlPath: string;
  renderedNodeCount: number;
  renderedEdgeCount: number;
  totalResolvedPairCount: number;
}

interface PositionedNode extends ExplorationTopologyNode {
  x: number;
  y: number;
  radius: number;
  color: string;
}

interface AggregatedEdge {
  fromNodeId: string;
  toNodeId: string;
  count: number;
  edgeIds: string[];
  labels: string[];
}

const SVG_WIDTH = 1400;
const SVG_HEIGHT = 920;
const MAX_RENDERED_EDGES = 900;

export async function writeExplorationVisualization(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationVisualizationResult> {
  const topology = await createExplorationTopologyArtifact({
    domain: input.domain,
    runDir: input.runDir,
    writeArtifact: true,
  });
  const topologyPath =
    topology.artifactPath || path.join(topology.runDir, "graph-topology.json");
  const htmlPath = path.join(topology.runDir, "graph.html");
  await fs.writeFile(htmlPath, renderExplorationTopologyHtml(topology), "utf8");
  const renderedEdges = aggregateKnownEdges(topology.edges).slice(
    0,
    MAX_RENDERED_EDGES,
  );
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir: topology.runDir,
    topologyPath,
    htmlPath,
    renderedNodeCount: topology.nodes.length,
    renderedEdgeCount: renderedEdges.length,
    totalResolvedPairCount: aggregateKnownEdges(topology.edges).length,
  };
}

export function renderExplorationTopologyHtml(
  topology: ExplorationTopologyArtifact,
): string {
  const positioned = positionNodes(topology.nodes);
  const byId = new Map(positioned.map((node) => [node.nodeId, node]));
  const renderedEdges = aggregateKnownEdges(topology.edges).slice(0, MAX_RENDERED_EDGES);
  const typeCounts = countsFor(topology.nodes.map((node) => node.surfaceType));
  const statusRows = Object.entries(topology.statusCounts)
    .map(
      ([status, count]) =>
        `<tr><td>${escapeHtml(status)}</td><td>${count.toLocaleString()}</td></tr>`,
    )
    .join("\n");
  const typeRows = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([type, count]) =>
        `<tr><td><span class="swatch" style="background:${colorFor(type)}"></span>${escapeHtml(type)}</td><td>${count.toLocaleString()}</td></tr>`,
    )
    .join("\n");
  const unresolvedRows = topology.edges
    .filter(
      (edge) =>
        edge.targetStatus === "uncaptured" ||
        edge.targetStatus === "external" ||
        edge.targetStatus === "unresolved" ||
        edge.targetStatus === "write_risk",
    )
    .slice()
    .sort((a, b) => statusSort(a.targetStatus) - statusSort(b.targetStatus))
    .slice(0, 80)
    .map(
      (edge) => `<tr>
        <td>${escapeHtml(edge.targetStatus)}</td>
        <td>${escapeHtml(edge.fromNodeId)}</td>
        <td>${escapeHtml(edge.label)}</td>
        <td>${escapeHtml(edge.toUrl || edge.href || "")}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(topology.domain)} exploration graph</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #14202a;
      --muted: #667789;
      --line: #d9e0e7;
      --panel: #f7f9fb;
      --accent: #0f766e;
      --warn: #b45309;
      --danger: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: #ffffff;
    }
    header {
      padding: 18px 24px 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
    }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    .subtle { color: var(--muted); font-size: 12px; }
    main { display: grid; grid-template-columns: minmax(700px, 1fr) 360px; min-height: calc(100vh - 74px); }
    .canvas { overflow: auto; background: linear-gradient(#fff, #fbfcfd); }
    aside { border-left: 1px solid var(--line); background: var(--panel); padding: 16px; overflow: auto; }
    svg { display: block; min-width: ${SVG_WIDTH}px; min-height: ${SVG_HEIGHT}px; }
    .edge { stroke: #94a3b8; stroke-width: 1.1; stroke-opacity: .28; fill: none; }
    .edge.heavy { stroke-width: 2; stroke-opacity: .42; }
    .node { stroke: #ffffff; stroke-width: 1.5; }
    .node-root { stroke: #111827; stroke-width: 3; }
    .label { font-size: 10px; fill: #263645; paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; }
    .badge { font-size: 10px; fill: var(--muted); }
    table { width: 100%; border-collapse: collapse; margin: 10px 0 18px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 5px 4px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    td:last-child, th:last-child { text-align: right; }
    .wide td:last-child, .wide th:last-child { text-align: left; word-break: break-word; }
    .metric { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
    .metric div { background: white; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
    .metric b { display: block; font-size: 18px; }
    .metric span { color: var(--muted); font-size: 11px; }
    .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(topology.domain)} exploration graph</h1>
      <div class="subtle">Run: <code>${escapeHtml(topology.runDir)}</code></div>
    </div>
    <div class="subtle">Generated: ${escapeHtml(topology.generatedAt)}</div>
  </header>
  <main>
    <section class="canvas">
      <svg viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="Exploration graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"></path>
          </marker>
        </defs>
        ${renderEdges(renderedEdges, byId)}
        ${renderNodes(positioned, topology.rootNodeId)}
      </svg>
    </section>
    <aside>
      <section class="metric">
        <div><b>${topology.summary.nodeCount.toLocaleString()}</b><span>Nodes</span></div>
        <div><b>${topology.summary.edgeCount.toLocaleString()}</b><span>Candidate edges</span></div>
        <div><b>${topology.summary.reachableNodeCount.toLocaleString()}</b><span>Reachable nodes</span></div>
        <div><b>${topology.summary.uncapturedNavigationEdgeCount.toLocaleString()}</b><span>Uncaptured nav edges</span></div>
      </section>
      <h2>Target Status</h2>
      <table><tbody>${statusRows}</tbody></table>
      <h2>Surface Types</h2>
      <table><tbody>${typeRows}</tbody></table>
      <h2>Known Graph</h2>
      <table>
        <tbody>
          <tr><td>Rendered resolved pairs</td><td>${renderedEdges.length.toLocaleString()}</td></tr>
          <tr><td>Total resolved pairs</td><td>${aggregateKnownEdges(topology.edges).length.toLocaleString()}</td></tr>
          <tr><td>Duplicate resolved pairs</td><td>${topology.summary.duplicateResolvedPairCount.toLocaleString()}</td></tr>
          <tr><td>Self loops</td><td>${topology.summary.selfLoopEdgeCount.toLocaleString()}</td></tr>
        </tbody>
      </table>
      <h2>Edges To Inspect</h2>
      <table class="wide">
        <thead><tr><th>Status</th><th>From</th><th>Label</th><th>Target</th></tr></thead>
        <tbody>${unresolvedRows || `<tr><td colspan="4">No risky or unresolved edges in the first inspection window.</td></tr>`}</tbody>
      </table>
    </aside>
  </main>
</body>
</html>
`;
}

function renderEdges(edges: AggregatedEdge[], nodes: Map<string, PositionedNode>): string {
  return edges
    .map((edge) => {
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to || from.nodeId === to.nodeId) return "";
      const heavy = edge.count > 2 ? " heavy" : "";
      const labels = escapeHtml(edge.labels.slice(0, 5).join(", "));
      return `<line class="edge${heavy}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" marker-end="url(#arrow)">
        <title>${escapeHtml(edge.fromNodeId)} -> ${escapeHtml(edge.toNodeId)} (${edge.count} edges: ${labels})</title>
      </line>`;
    })
    .join("\n");
}

function renderNodes(nodes: PositionedNode[], rootNodeId: string | undefined): string {
  return nodes
    .map((node) => {
      const rootClass = node.nodeId === rootNodeId ? " node-root" : "";
      const label = compactNodeLabel(node.nodeId);
      const selfLoops = node.selfLoopEdgeCount
        ? `<text class="badge" x="${node.x + node.radius + 4}" y="${node.y - node.radius}">${node.selfLoopEdgeCount} self</text>`
        : "";
      return `<g>
        <circle class="node${rootClass}" cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="${node.color}">
          <title>${escapeHtml(node.nodeId)}\n${escapeHtml(node.surfaceType)}\n${escapeHtml(node.url)}</title>
        </circle>
        <text class="label" x="${node.x + node.radius + 4}" y="${node.y + 3}">${escapeHtml(label)}</text>
        ${selfLoops}
      </g>`;
    })
    .join("\n");
}

function positionNodes(nodes: ExplorationTopologyNode[]): PositionedNode[] {
  const groups = new Map<string, ExplorationTopologyNode[]>();
  for (const node of nodes) {
    const current = groups.get(node.surfaceType) || [];
    current.push(node);
    groups.set(node.surfaceType, current);
  }
  const groupEntries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const centerX = SVG_WIDTH / 2;
  const centerY = SVG_HEIGHT / 2;
  const groupRadius = Math.min(SVG_WIDTH, SVG_HEIGHT) * 0.36;
  const positioned: PositionedNode[] = [];
  for (const [groupIndex, [surfaceType, groupNodes]] of groupEntries.entries()) {
    const angle = (Math.PI * 2 * groupIndex) / Math.max(1, groupEntries.length);
    const groupCenterX = centerX + Math.cos(angle) * groupRadius;
    const groupCenterY = centerY + Math.sin(angle) * groupRadius;
    const localRadius = 34 + Math.sqrt(groupNodes.length) * 18;
    for (const [nodeIndex, node] of groupNodes
      .slice()
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .entries()) {
      const localAngle = (Math.PI * 2 * nodeIndex) / Math.max(1, groupNodes.length);
      const ring = groupNodes.length === 1 ? 0 : localRadius;
      positioned.push({
        ...node,
        x: Math.round(groupCenterX + Math.cos(localAngle) * ring),
        y: Math.round(groupCenterY + Math.sin(localAngle) * ring),
        radius: Math.min(18, 6 + Math.sqrt(node.incomingKnownEdgeCount + node.outgoingEdgeCount)),
        color: colorFor(surfaceType),
      });
    }
  }
  return positioned;
}

function aggregateKnownEdges(edges: ExplorationTopologyEdge[]): AggregatedEdge[] {
  const byPair = new Map<string, AggregatedEdge>();
  for (const edge of edges) {
    if (
      edge.actionKind !== "navigate" ||
      edge.writeRisk !== "none" ||
      !edge.toNodeId ||
      edge.fromNodeId === edge.toNodeId ||
      edge.targetStatus !== "known"
    ) {
      continue;
    }
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    const current =
      byPair.get(key) ||
      {
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        count: 0,
        edgeIds: [],
        labels: [],
      };
    current.count += 1;
    current.edgeIds.push(edge.edgeId);
    if (!current.labels.includes(edge.label)) current.labels.push(edge.label);
    byPair.set(key, current);
  }
  return [...byPair.values()].sort(
    (a, b) => b.count - a.count || a.fromNodeId.localeCompare(b.fromNodeId),
  );
}

function countsFor(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function compactNodeLabel(nodeId: string): string {
  const trimmed = nodeId.replace(/^yc_/, "");
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 25)}...`;
}

function colorFor(value: string): string {
  const palette = [
    "#0f766e",
    "#2563eb",
    "#9333ea",
    "#c2410c",
    "#be123c",
    "#4d7c0f",
    "#0369a1",
    "#7c3aed",
    "#a16207",
    "#475569",
  ];
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function statusSort(status: string): number {
  const order = ["write_risk", "unresolved", "external", "uncaptured"];
  const index = order.indexOf(status);
  return index === -1 ? order.length : index;
}

function escapeHtml(value: string | undefined): string {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
