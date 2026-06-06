import fs from "node:fs/promises";
import path from "node:path";
import type { Domain } from "../contracts.js";
import { readJsonFile, writeJsonFile } from "../fs-json.js";
import { siteDir } from "../paths.js";
import type { ExplorationHarnessResult } from "./harness-contracts.js";
import type {
  CandidateEdgesArtifact,
  ControlDiffArtifact,
  EdgeReconciliationArtifact,
  GraphCandidate,
  NodeMatchArtifact,
  SurfaceClassification,
} from "./post-capture.js";
import {
  evaluateExplorationTopologyQuality,
  resolveExplorationTopology,
} from "./topology.js";

export interface ExplorationRunVerification {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  ok: boolean;
  checkedAt: string;
  summary: {
    captureCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    writeRiskEdgeCount: number;
    missingArtifactCount: number;
    mismatchCount: number;
    topologyKnownNavigationEdgeCount: number;
    topologyUncapturedNavigationEdgeCount: number;
    topologySelfLoopEdgeCount: number;
    topologyDuplicateResolvedPairCount: number;
    topologyUnreachableNodeCount: number;
  };
  findings: ExplorationRunVerificationFinding[];
}

export interface ExplorationRunVerificationFinding {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface ExplorationRunSummary {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  goal?: string;
  captureCount: number;
  graph: {
    nodeCount: number;
    edgeCount: number;
    writeRiskEdgeCount: number;
    nodes: Array<{
      nodeId: string;
      surfaceType: string;
      urlShape: string;
      outgoingEdgeCount: number;
      writeRiskEdgeCount: number;
    }>;
    topEdges: Array<{
      fromNodeId: string;
      label: string;
      href?: string;
      actionKind: string;
      writeRisk: string;
      warnings: string[];
    }>;
  };
  reconciliation: {
    matchedCaptureCount: number;
    stableControlCount: number;
    newControlCandidateCount: number;
    stableEdgeCount: number;
    newEdgeCandidateCount: number;
  };
}

export async function verifyExplorationRun(input: {
  domain: Domain;
  runDir?: string;
  writeArtifact?: boolean;
}): Promise<ExplorationRunVerification> {
  const runDir = input.runDir || (await latestExplorationRunDir(input.domain));
  const findings: ExplorationRunVerificationFinding[] = [];
  const runPath = path.join(runDir, "run.json");
  const graphPath = path.join(runDir, "graph-candidate.json");
  const run = await readJsonFile<ExplorationHarnessResult>(runPath);
  const graph = await readJsonFile<GraphCandidate>(graphPath);

  if (!run) {
    findings.push(errorFinding("missing_run", "Missing run.json", runPath));
  }
  if (!graph) {
    findings.push(
      errorFinding(
        "missing_graph_candidate",
        "Missing graph-candidate.json",
        graphPath,
      ),
    );
  }
  if (run && run.domain !== input.domain) {
    findings.push(
      errorFinding(
        "domain_mismatch",
        `run.json domain ${run.domain} does not match ${input.domain}`,
        runPath,
      ),
    );
  }
  if (graph && graph.domain !== input.domain) {
    findings.push(
      errorFinding(
        "graph_domain_mismatch",
        `graph-candidate domain ${graph.domain} does not match ${input.domain}`,
        graphPath,
      ),
    );
  }

  if (run) {
    await verifyCaptureArtifacts(run, graph, findings);
  }
  const topology = graph
    ? resolveExplorationTopology({
        domain: input.domain,
        runDir,
        graphPath,
        graph,
      })
    : null;
  if (graph) verifyGraphCandidate(graph, findings, graphPath);
  if (topology) {
    const quality = evaluateExplorationTopologyQuality(topology);
    for (const finding of quality.findings) {
      findings.push({
        level: finding.level,
        code: finding.code,
        message: finding.message,
        path: graphPath,
      });
    }
  }

  const missingArtifactCount = findings.filter((finding) =>
    finding.code.startsWith("missing_"),
  ).length;
  const mismatchCount = findings.filter(
    (finding) =>
      finding.code.includes("mismatch") ||
      finding.code.includes("inconsistent") ||
      finding.code.includes("invalid"),
  ).length;
  const verification: ExplorationRunVerification = {
    schemaVersion: 1,
    domain: input.domain,
    runDir,
    ok: !findings.some((finding) => finding.level === "error"),
    checkedAt: new Date().toISOString(),
    summary: {
      captureCount: run?.captures.length || 0,
      graphNodeCount: graph?.nodes.length || 0,
      graphEdgeCount: graph?.edges.length || 0,
      writeRiskEdgeCount:
        graph?.edges.filter((edge) => edge.writeRisk !== "none").length || 0,
      missingArtifactCount,
      mismatchCount,
      topologyKnownNavigationEdgeCount:
        topology?.summary.knownNavigationEdgeCount || 0,
      topologyUncapturedNavigationEdgeCount:
        topology?.summary.uncapturedNavigationEdgeCount || 0,
      topologySelfLoopEdgeCount: topology?.summary.selfLoopEdgeCount || 0,
      topologyDuplicateResolvedPairCount:
        topology?.summary.duplicateResolvedPairCount || 0,
      topologyUnreachableNodeCount: topology?.summary.unreachableNodeCount || 0,
    },
    findings,
  };
  if (input.writeArtifact) {
    await writeJsonFile(path.join(runDir, "verification.json"), verification);
    if (topology) {
      topology.artifactPath = path.join(runDir, "graph-topology.json");
      await writeJsonFile(topology.artifactPath, topology);
    }
  }
  return verification;
}

export async function summarizeExplorationRun(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationRunSummary> {
  const runDir = input.runDir || (await latestExplorationRunDir(input.domain));
  const run = await readJsonFile<ExplorationHarnessResult>(
    path.join(runDir, "run.json"),
  );
  const graph = await readJsonFile<GraphCandidate>(
    path.join(runDir, "graph-candidate.json"),
  );
  if (!run) throw new Error(`Missing run.json in ${runDir}`);
  if (!graph) throw new Error(`Missing graph-candidate.json in ${runDir}`);

  const edgeCounts = new Map<string, { total: number; writeRisk: number }>();
  for (const edge of graph.edges) {
    const current = edgeCounts.get(edge.fromNodeId) || {
      total: 0,
      writeRisk: 0,
    };
    current.total += 1;
    if (edge.writeRisk !== "none") current.writeRisk += 1;
    edgeCounts.set(edge.fromNodeId, current);
  }

  const reconciliation = {
    matchedCaptureCount: 0,
    stableControlCount: 0,
    newControlCandidateCount: 0,
    stableEdgeCount: 0,
    newEdgeCandidateCount: 0,
  };
  for (const capture of run.captures) {
    const nodeMatch = capture.nodeMatchPath
      ? await readJsonFile<NodeMatchArtifact>(capture.nodeMatchPath)
      : null;
    const controlDiff = capture.controlDiffPath
      ? await readJsonFile<ControlDiffArtifact>(capture.controlDiffPath)
      : null;
    const edgeReconciliation = capture.edgeReconciliationPath
      ? await readJsonFile<EdgeReconciliationArtifact>(
          capture.edgeReconciliationPath,
        )
      : null;
    if (nodeMatch?.matched) reconciliation.matchedCaptureCount += 1;
    if (controlDiff) {
      reconciliation.stableControlCount += controlDiff.summary.stable;
      reconciliation.newControlCandidateCount +=
        controlDiff.summary.newCandidate;
    }
    if (edgeReconciliation) {
      reconciliation.stableEdgeCount += edgeReconciliation.summary.stable;
      reconciliation.newEdgeCandidateCount +=
        edgeReconciliation.summary.newCandidate;
    }
  }

  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir,
    goal: run.goal,
    captureCount: run.captures.length,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      writeRiskEdgeCount: graph.edges.filter(
        (edge) => edge.writeRisk !== "none",
      ).length,
      nodes: graph.nodes.map((node) => {
        const counts = edgeCounts.get(node.nodeId) || {
          total: 0,
          writeRisk: 0,
        };
        return {
          nodeId: node.nodeId,
          surfaceType: node.surfaceType,
          urlShape: node.urlShape,
          outgoingEdgeCount: counts.total,
          writeRiskEdgeCount: counts.writeRisk,
        };
      }),
      topEdges: graph.edges
        .slice()
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 20)
        .map((edge) => ({
          fromNodeId: edge.fromNodeId,
          label: edge.label,
          href: edge.href,
          actionKind: edge.actionKind,
          writeRisk: edge.writeRisk,
          warnings: edge.warnings,
        })),
    },
    reconciliation,
  };
}

async function verifyCaptureArtifacts(
  run: ExplorationHarnessResult,
  graph: GraphCandidate | null,
  findings: ExplorationRunVerificationFinding[],
): Promise<void> {
  for (const capture of run.captures) {
    const requiredPaths = [
      ["surface_json", capture.surfaceJsonPath],
      ["markdown", capture.markdownPath],
      ["screenshot", capture.screenshotPath],
      ["classification", capture.classificationPath],
      ["node_match", capture.nodeMatchPath],
      ["control_diff", capture.controlDiffPath],
      ["candidate_edges", capture.candidateEdgesPath],
      ["edge_reconciliation", capture.edgeReconciliationPath],
      ["graph_mutation", capture.graphMutationPath],
    ] as const;
    for (const [name, artifactPath] of requiredPaths) {
      if (!artifactPath || !(await fileExists(artifactPath))) {
        findings.push(
          errorFinding(
            `missing_${name}`,
            `Missing ${name} artifact for ${capture.captureId}`,
            artifactPath,
          ),
        );
      }
    }
    const classification = capture.classificationPath
      ? await readJsonFile<SurfaceClassification>(capture.classificationPath)
      : null;
    const candidateEdges = capture.candidateEdgesPath
      ? await readJsonFile<CandidateEdgesArtifact>(capture.candidateEdgesPath)
      : null;
    const nodeMatch = capture.nodeMatchPath
      ? await readJsonFile<NodeMatchArtifact>(capture.nodeMatchPath)
      : null;
    const controlDiff = capture.controlDiffPath
      ? await readJsonFile<ControlDiffArtifact>(capture.controlDiffPath)
      : null;
    const edgeReconciliation = capture.edgeReconciliationPath
      ? await readJsonFile<EdgeReconciliationArtifact>(
          capture.edgeReconciliationPath,
        )
      : null;

    if (classification && classification.surfaceType !== capture.surfaceType) {
      findings.push(
        errorFinding(
          "surface_type_mismatch",
          `${capture.captureId} run surface type ${capture.surfaceType} does not match classification ${classification.surfaceType}`,
          capture.classificationPath,
        ),
      );
    }
    if (
      candidateEdges &&
      candidateEdges.edgeCount !== capture.candidateEdgeCount
    ) {
      findings.push(
        errorFinding(
          "candidate_edge_count_mismatch",
          `${capture.captureId} run edge count ${capture.candidateEdgeCount} does not match candidate edge artifact ${candidateEdges.edgeCount}`,
          capture.candidateEdgesPath,
        ),
      );
    }
    if (nodeMatch && nodeMatch.matched && !nodeMatch.matchedNodeId) {
      findings.push(
        errorFinding(
          "invalid_node_match",
          `${capture.captureId} matched an existing node without matchedNodeId`,
          capture.nodeMatchPath,
        ),
      );
    }
    if (
      controlDiff &&
      sumControlSummary(controlDiff.summary) !== controlDiff.changes.length
    ) {
      findings.push(
        errorFinding(
          "control_diff_summary_mismatch",
          `${capture.captureId} control diff summary does not equal change count`,
          capture.controlDiffPath,
        ),
      );
    }
    if (
      edgeReconciliation &&
      sumEdgeSummary(edgeReconciliation.summary) !==
        edgeReconciliation.edges.length
    ) {
      findings.push(
        errorFinding(
          "edge_reconciliation_summary_mismatch",
          `${capture.captureId} edge reconciliation summary does not equal change count`,
          capture.edgeReconciliationPath,
        ),
      );
    }
    if (
      graph &&
      classification?.stable &&
      !graph.nodes.some((node) => node.nodeId === classification.nodeId)
    ) {
      findings.push(
        errorFinding(
          "graph_missing_classified_node",
          `${capture.captureId} classified node ${classification.nodeId} is missing from graph candidate`,
          capture.classificationPath,
        ),
      );
    }
  }
}

function verifyGraphCandidate(
  graph: GraphCandidate,
  findings: ExplorationRunVerificationFinding[],
  graphPath: string,
): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  const duplicateNodeIds = duplicates(graph.nodes.map((node) => node.nodeId));
  for (const nodeId of duplicateNodeIds) {
    findings.push(
      errorFinding(
        "duplicate_graph_node_id",
        `Graph candidate contains duplicate node id ${nodeId}`,
        graphPath,
      ),
    );
  }
  const duplicateUrlShapes = duplicates(
    graph.nodes.map((node) => node.urlShape),
  );
  for (const urlShape of duplicateUrlShapes) {
    findings.push(
      errorFinding(
        "duplicate_graph_url_shape",
        `Graph candidate contains duplicate URL shape ${urlShape}`,
        graphPath,
      ),
    );
  }
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.fromNodeId)) {
      findings.push(
        errorFinding(
          "edge_from_node_missing",
          `Edge ${edge.edgeId} references missing fromNodeId ${edge.fromNodeId}`,
          graphPath,
        ),
      );
    }
    if (edge.writeRisk !== "none" && !edge.warnings.length) {
      findings.push(
        errorFinding(
          "write_edge_without_warning",
          `Write-risk edge ${edge.edgeId} has no warning metadata`,
          graphPath,
        ),
      );
    }
  }
}

async function latestExplorationRunDir(domain: Domain): Promise<string> {
  const runsDir = path.join(siteDir(domain), "exploration-runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
  const latest = runs.at(-1);
  if (!latest) throw new Error(`No exploration runs found for ${domain}`);
  return latest;
}

async function fileExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sumControlSummary(summary: ControlDiffArtifact["summary"]): number {
  return (
    summary.stable +
    summary.driftedSelector +
    summary.renamed +
    summary.missing +
    summary.newCandidate
  );
}

function sumEdgeSummary(
  summary: EdgeReconciliationArtifact["summary"],
): number {
  return (
    summary.stable +
    summary.driftedSelector +
    summary.renamed +
    summary.missing +
    summary.newCandidate
  );
}

function errorFinding(
  code: string,
  message: string,
  artifactPath?: string,
): ExplorationRunVerificationFinding {
  return { level: "error", code, message, path: artifactPath };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues].sort();
}
