import path from "node:path";
import type { Domain } from "../contracts.js";
import { fileExists, writeJsonFile } from "../fs-json.js";
import {
  createExplorationTopologyArtifact,
  evaluateExplorationTopologyQuality,
} from "./topology.js";
import type { ExplorationTopologyArtifact } from "./topology.js";

export interface ExplorationAgentContract {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  generatedAt: string;
  graph: {
    graphCandidatePath: string;
    topologyPath: string;
    visualizationPath?: string;
    verificationPath?: string;
    nodeCount: number;
    edgeCount: number;
    reachableNodeCount: number;
    unreachableNodeCount: number;
    writeRiskEdgeCount: number;
    uncapturedNavigationEdgeCount: number;
    duplicateResolvedPairCount: number;
    canonicalNavigationEdgeCount: number;
  };
  health: {
    ok: boolean;
    findings: ReturnType<typeof evaluateExplorationTopologyQuality>["findings"];
  };
  commands: {
    summary: string;
    topology: string;
    visualize: string;
    verify: string;
    graph: string;
    progress: string;
  };
  routing: {
    rootNodeId?: string;
    safeNavigationChains: Array<{
      edgeId: string;
      fromNodeId: string;
      toNodeId: string;
      label: string;
      chainStep: string;
    }>;
    writeRiskActions: Array<{
      edgeId: string;
      fromNodeId: string;
      label: string;
      actionKind: string;
      warnings: string[];
    }>;
  };
  rules: string[];
}

export async function writeExplorationAgentContract(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationAgentContract & { artifactPath: string }> {
  const topology = await createExplorationTopologyArtifact({
    domain: input.domain,
    runDir: input.runDir,
    writeArtifact: true,
  });
  const artifactPath = path.join(topology.runDir, "agent-contract.json");
  const contract = await buildExplorationAgentContract({
    domain: input.domain,
    topology,
  });
  await writeJsonFile(artifactPath, contract);
  return { ...contract, artifactPath };
}

export async function buildExplorationAgentContract(input: {
  domain: Domain;
  topology: ExplorationTopologyArtifact;
}): Promise<ExplorationAgentContract> {
  const quality = evaluateExplorationTopologyQuality(input.topology);
  const topologyPath =
    input.topology.artifactPath ||
    path.join(input.topology.runDir, "graph-topology.json");
  const visualizationPath = path.join(input.topology.runDir, "graph.html");
  const verificationPath = path.join(
    input.topology.runDir,
    "verification.json",
  );
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir: input.topology.runDir,
    generatedAt: new Date().toISOString(),
    graph: {
      graphCandidatePath: input.topology.graphPath,
      topologyPath,
      visualizationPath: (await fileExists(visualizationPath))
        ? visualizationPath
        : undefined,
      verificationPath: (await fileExists(verificationPath))
        ? verificationPath
        : undefined,
      nodeCount: input.topology.summary.nodeCount,
      edgeCount: input.topology.summary.edgeCount,
      reachableNodeCount: input.topology.summary.reachableNodeCount,
      unreachableNodeCount: input.topology.summary.unreachableNodeCount,
      writeRiskEdgeCount: input.topology.summary.writeRiskEdgeCount,
      uncapturedNavigationEdgeCount:
        input.topology.summary.uncapturedNavigationEdgeCount,
      duplicateResolvedPairCount:
        input.topology.summary.duplicateResolvedPairCount,
      canonicalNavigationEdgeCount:
        input.topology.canonicalNavigationEdges.length,
    },
    health: {
      ok: quality.ok,
      findings: quality.findings,
    },
    commands: {
      summary: `cg exploration-summary ${input.domain} ${input.topology.runDir}`,
      topology: `cg exploration-topology ${input.domain} ${input.topology.runDir}`,
      visualize: `cg exploration-visualize ${input.domain} ${input.topology.runDir}`,
      verify: `cg verify-exploration-run ${input.domain} ${input.topology.runDir} --write`,
      graph: `cg exploration-graph ${input.domain} ${input.topology.runDir}`,
      progress: `cg exploration-progress ${input.domain} ${input.topology.runDir}`,
    },
    routing: {
      rootNodeId: input.topology.rootNodeId,
      safeNavigationChains: input.topology.canonicalNavigationEdges
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 50)
        .map((edge) => ({
          edgeId: edge.edgeId,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          label: edge.label,
          chainStep: `action:${edge.edgeId}`,
        })),
      writeRiskActions: input.topology.edges
        .filter((edge) => edge.targetStatus === "write_risk")
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 50)
        .map((edge) => ({
          edgeId: edge.edgeId,
          fromNodeId: edge.fromNodeId,
          label: edge.label,
          actionKind: edge.actionKind,
          warnings: edge.warnings,
        })),
    },
    rules: [
      "Use known safe navigation chains for deterministic routing.",
      "Treat uncaptured navigation edges as crawl frontier, not executable proof.",
      "Treat write-risk actions as warnings; execute them only through explicit write policy.",
      "Use graph-candidate.json for raw evidence and graph-topology.json for planning.",
      "Use canonicalNavigationEdges for planning; raw duplicate candidate edges are retained only for inspection.",
      "Run verify-exploration-run before relying on a resumed or externally modified run.",
    ],
  };
}
