import test from "node:test";
import assert from "node:assert/strict";
import type { GraphCandidate, CandidateEdge } from "./post-capture.js";
import {
  evaluateExplorationTopologyQuality,
  findExplorationNodeForUrl,
  resolveExplorationTopology,
} from "./topology.js";

test("resolveExplorationTopology classifies known, self, uncaptured, external, write-risk, and blocked edges", () => {
  const graph = graphFixture();
  const topology = resolveExplorationTopology({
    domain: "ycombinator.com",
    runDir: "/tmp/cartographer-test-run",
    graphPath: "/tmp/cartographer-test-run/graph-candidate.json",
    graph,
  });

  assert.equal(topology.summary.nodeCount, 3);
  assert.equal(topology.summary.edgeCount, 7);
  assert.equal(topology.statusCounts.known, 2);
  assert.equal(topology.statusCounts.self, 1);
  assert.equal(topology.statusCounts.uncaptured, 1);
  assert.equal(topology.statusCounts.external, 1);
  assert.equal(topology.statusCounts.write_risk, 1);
  assert.equal(topology.statusCounts.blocked, 1);
  assert.equal(topology.summary.duplicateResolvedPairCount, 1);
  assert.deepEqual(
    topology.canonicalNavigationEdges
      .filter(
        (edge) => edge.fromNodeId === "yc_home" && edge.toNodeId === "yc_about",
      )
      .map((edge) => ({
        edgeId: edge.edgeId,
        duplicateAlternativeEdgeIds: edge.duplicateAlternativeEdgeIds,
      })),
    [{ edgeId: "e_about_2", duplicateAlternativeEdgeIds: ["e_about_1"] }],
  );
  assert.equal(
    topology.duplicateResolvedPairs[0]?.canonicalEdgeId,
    "e_about_2",
  );
  assert.deepEqual(topology.unreachableNodeIds, ["yc_orphan"]);
});

test("findExplorationNodeForUrl uses exact URL and URL shape matching", () => {
  const graph = graphFixture();
  assert.equal(
    findExplorationNodeForUrl(graph, "https://www.ycombinator.com/about#team")
      ?.nodeId,
    "yc_about",
  );
});

test("findExplorationNodeForUrl treats trailing slash variants as the same surface", () => {
  const graph = graphFixture();
  assert.equal(
    findExplorationNodeForUrl(graph, "https://www.ycombinator.com/about/")
      ?.nodeId,
    "yc_about",
  );
});

test("findExplorationNodeForUrl does not guess between ambiguous URL shapes", () => {
  const graph = graphFixture();
  graph.nodes.push(
    node(
      "yc_companies_w24",
      "yc_companies",
      "https://www.ycombinator.com/companies?batch=W24",
    ),
    node(
      "yc_companies_s24",
      "yc_companies",
      "https://www.ycombinator.com/companies?batch=S24",
    ),
  );
  assert.equal(
    findExplorationNodeForUrl(
      graph,
      "https://www.ycombinator.com/companies?batch=X25",
    ),
    undefined,
  );
});

test("evaluateExplorationTopologyQuality reports warnings without failing non-empty topology", () => {
  const topology = resolveExplorationTopology({
    domain: "ycombinator.com",
    runDir: "/tmp/cartographer-test-run",
    graphPath: "/tmp/cartographer-test-run/graph-candidate.json",
    graph: graphFixture(),
  });
  const quality = evaluateExplorationTopologyQuality(topology);
  assert.equal(quality.ok, true);
  assert(
    quality.findings.some(
      (finding) => finding.code === "topology_unreachable_nodes",
    ),
  );
  assert(
    quality.findings.some(
      (finding) => finding.code === "topology_duplicate_resolved_pairs",
    ),
  );
});

function graphFixture(): GraphCandidate {
  return {
    schemaVersion: 1,
    domain: "ycombinator.com",
    updatedAt: "2026-06-01T00:00:00.000Z",
    nodes: [
      node("yc_home", "yc_home", "https://www.ycombinator.com/"),
      node("yc_about", "yc_about", "https://www.ycombinator.com/about"),
      node(
        "yc_orphan",
        "yc_content_page",
        "https://www.ycombinator.com/orphan",
      ),
    ],
    edges: [
      edge("e_about_1", "yc_home", "About", "navigate", "none", "/about"),
      edge("e_about_2", "yc_home", "Team", "navigate", "none", "/about"),
      edge("e_home", "yc_home", "Y Combinator", "navigate", "none", "/"),
      edge("e_missing", "yc_home", "Missing", "navigate", "none", "/missing"),
      edge(
        "e_external",
        "yc_home",
        "External",
        "navigate",
        "none",
        "https://news.ycombinator.com/",
      ),
      edge("e_write", "yc_home", "Email", "input", "possible"),
      edge("e_blocked", "yc_about", "Open menu", "click", "none"),
    ],
  };
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
  actionKind: CandidateEdge["actionKind"],
  writeRisk: CandidateEdge["writeRisk"],
  href?: string,
): CandidateEdge {
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
    writeRisk,
    warnings: writeRisk === "none" ? [] : ["may write"],
    selectorCandidates: [],
    evidence: {
      rect: { x: 0, y: 0, width: 10, height: 10 },
      context: {},
    },
  };
}
