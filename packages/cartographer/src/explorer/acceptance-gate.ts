import path from "node:path";
import type { Domain } from "../contracts.js";
import { writeJsonFile } from "../fs-json.js";
import { runExplorationChain } from "./graph-cli.js";
import type {
  ExplorationChainResult,
  ExplorationPathResult,
} from "./graph-cli.js";
import { writeExplorationAgentContract } from "./agent-contract.js";
import { createExplorationTopologyArtifact } from "./topology.js";
import type { ExplorationTopologyArtifact } from "./topology.js";
import { verifyExplorationRun } from "./verification.js";
import { writeExplorationVisualization } from "./visualization.js";

export interface ExplorationHandoffBundleResult {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  ok: boolean;
  generatedAt: string;
  artifacts: {
    verificationPath: string;
    topologyPath: string;
    visualizationPath: string;
    agentContractPath: string;
    handoffBundlePath: string;
  };
  summary: {
    nodeCount: number;
    edgeCount: number;
    canonicalNavigationEdgeCount: number;
    duplicateResolvedPairCount: number;
    verificationOk: boolean;
  };
}

export interface ExplorationAgentEvalResult {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  runDir: string;
  ok: boolean;
  generatedAt: string;
  criteria: {
    minPathLength: number;
    targetCount: number;
    excludeTopLevelNodes: boolean;
    dryRun: boolean;
  };
  selectedTargetCount: number;
  targets: ExplorationAgentEvalTarget[];
  artifactPath?: string;
}

export interface ExplorationAgentEvalTarget {
  nodeId: string;
  surfaceType: string;
  url: string;
  pathLength: number;
  path: ExplorationPathResult;
  deterministic?: boolean;
  chain?: ExplorationChainResult;
  error?: string;
}

export async function writeExplorationHandoffBundle(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationHandoffBundleResult> {
  const verification = await verifyExplorationRun({
    domain: input.domain,
    runDir: input.runDir,
    writeArtifact: true,
  });
  const topology = await createExplorationTopologyArtifact({
    domain: input.domain,
    runDir: verification.runDir,
    writeArtifact: true,
  });
  const visualization = await writeExplorationVisualization({
    domain: input.domain,
    runDir: verification.runDir,
  });
  const contract = await writeExplorationAgentContract({
    domain: input.domain,
    runDir: verification.runDir,
  });
  const handoffBundlePath = path.join(
    verification.runDir,
    "handoff-bundle.json",
  );
  const bundle: ExplorationHandoffBundleResult = {
    schemaVersion: 1,
    domain: input.domain,
    runDir: verification.runDir,
    ok: verification.ok,
    generatedAt: new Date().toISOString(),
    artifacts: {
      verificationPath: path.join(verification.runDir, "verification.json"),
      topologyPath:
        topology.artifactPath ||
        path.join(verification.runDir, "graph-topology.json"),
      visualizationPath: visualization.htmlPath,
      agentContractPath: contract.artifactPath,
      handoffBundlePath,
    },
    summary: {
      nodeCount: topology.summary.nodeCount,
      edgeCount: topology.summary.edgeCount,
      canonicalNavigationEdgeCount: topology.canonicalNavigationEdges.length,
      duplicateResolvedPairCount: topology.summary.duplicateResolvedPairCount,
      verificationOk: verification.ok,
    },
  };
  await writeJsonFile(handoffBundlePath, bundle);
  return bundle;
}

export async function runExplorationAgentEval(input: {
  domain: Domain;
  runDir?: string;
  profile?: string;
  minPathLength?: number;
  targetCount?: number;
  excludeTopLevelNodes?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
}): Promise<ExplorationAgentEvalResult> {
  const profile = input.profile || "default";
  const minPathLength = input.minPathLength || 2;
  const targetCount = input.targetCount || 5;
  const excludeTopLevelNodes = input.excludeTopLevelNodes !== false;
  const verification = await verifyExplorationRun({
    domain: input.domain,
    runDir: input.runDir,
    writeArtifact: false,
  });
  const topology = await createExplorationTopologyArtifact({
    domain: input.domain,
    runDir: verification.runDir,
    writeArtifact: input.writeArtifact === true,
  });
  const selected = await selectDeepTargets({
    domain: input.domain,
    topology,
    minPathLength,
    targetCount,
    excludeTopLevelNodes,
  });
  const targets: ExplorationAgentEvalTarget[] = [];
  for (const target of selected) {
    if (input.dryRun) {
      targets.push(target);
      continue;
    }
    try {
      const chain = await runExplorationChain({
        domain: input.domain,
        runDir: verification.runDir,
        profile,
        steps: target.path.chainSteps,
      });
      targets.push({
        ...target,
        deterministic: chain.deterministic,
        chain,
      });
    } catch (error) {
      targets.push({
        ...target,
        deterministic: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const result: ExplorationAgentEvalResult = {
    schemaVersion: 1,
    domain: input.domain,
    profile,
    runDir: verification.runDir,
    ok:
      verification.ok &&
      selected.length >= targetCount &&
      targets.every((target) =>
        input.dryRun ? target.path.found : target.deterministic === true,
      ),
    generatedAt: new Date().toISOString(),
    criteria: {
      minPathLength,
      targetCount,
      excludeTopLevelNodes,
      dryRun: input.dryRun === true,
    },
    selectedTargetCount: selected.length,
    targets,
  };
  if (input.writeArtifact) {
    result.artifactPath = path.join(verification.runDir, "agent-eval.json");
    await writeJsonFile(result.artifactPath, result);
  }
  return result;
}

async function selectDeepTargets(input: {
  domain: Domain;
  topology: ExplorationTopologyArtifact;
  minPathLength: number;
  targetCount: number;
  excludeTopLevelNodes: boolean;
}): Promise<ExplorationAgentEvalTarget[]> {
  if (!input.topology.rootNodeId) return [];
  const paths = canonicalPathsFromRoot(input.topology);
  const targets: ExplorationAgentEvalTarget[] = [];
  for (const [nodeId, steps] of paths) {
    if (steps.length < input.minPathLength) continue;
    const node = input.topology.nodes.find(
      (candidate) => candidate.nodeId === nodeId,
    );
    if (!node) continue;
    if (input.excludeTopLevelNodes && isTopLevelUrl(node.url)) continue;
    const pathResult = pathResultFor({
      domain: input.domain,
      runDir: input.topology.runDir,
      fromNodeId: input.topology.rootNodeId,
      toNodeId: node.nodeId,
      steps,
    });
    targets.push({
      nodeId: node.nodeId,
      surfaceType: node.surfaceType,
      url: node.url,
      pathLength: pathResult.steps.length,
      path: pathResult,
    });
  }
  return targets
    .sort(
      (a, b) =>
        b.pathLength - a.pathLength ||
        b.path.steps.reduce((sum, step) => sum + step.label.length, 0) -
          a.path.steps.reduce((sum, step) => sum + step.label.length, 0) ||
        a.nodeId.localeCompare(b.nodeId),
    )
    .slice(0, input.targetCount);
}

function canonicalPathsFromRoot(
  topology: ExplorationTopologyArtifact,
): Map<string, ExplorationPathResult["steps"]> {
  const paths = new Map<string, ExplorationPathResult["steps"]>();
  if (!topology.rootNodeId) return paths;
  const queue: Array<{ nodeId: string; path: ExplorationPathResult["steps"] }> =
    [{ nodeId: topology.rootNodeId, path: [] }];
  const visited = new Set<string>([topology.rootNodeId]);
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of topology.canonicalNavigationEdges.filter(
      (candidate) => candidate.fromNodeId === current.nodeId,
    )) {
      if (visited.has(edge.toNodeId)) continue;
      const nextPath = [
        ...current.path,
        {
          fromNodeId: current.nodeId,
          edgeId: edge.edgeId,
          label: edge.label,
          href: edge.href,
          toNodeId: edge.toNodeId,
          toUrl: edge.toUrl,
        },
      ];
      visited.add(edge.toNodeId);
      paths.set(edge.toNodeId, nextPath);
      queue.push({ nodeId: edge.toNodeId, path: nextPath });
    }
  }
  return paths;
}

function pathResultFor(input: {
  domain: Domain;
  runDir: string;
  fromNodeId: string;
  toNodeId: string;
  steps: ExplorationPathResult["steps"];
}): ExplorationPathResult {
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir: input.runDir,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    found: input.fromNodeId === input.toNodeId || input.steps.length > 0,
    steps: input.steps,
    chainSteps: [
      `node:${input.fromNodeId}`,
      ...input.steps.map((step) => `action:${step.edgeId}`),
    ],
  };
}

function isTopLevelUrl(url: string): boolean {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return segments.length <= 1;
}
