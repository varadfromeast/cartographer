import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { Domain, TaskId } from "../contracts.js";
import { readJsonFile } from "../fs-json.js";
import { siteDir } from "../paths.js";
import { withBrowserProfileLock } from "../profile-lock.js";
import {
  closeTaskBrowser,
  connectOrStartTaskBrowser,
} from "../task-browser.js";
import type { GraphCandidate } from "./post-capture.js";
import type { CandidateEdge } from "./post-capture.js";
import {
  findExplorationNodeForUrl,
  resolveExplorationTopology,
} from "./topology.js";

export interface ExplorationGraphView {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  nodeCount: number;
  edgeCount: number;
  writeRiskEdgeCount: number;
  nodes: ExplorationGraphNodeView[];
}

export interface ExplorationGraphNodeView {
  nodeId: string;
  surfaceType: string;
  url: string;
  urlShape: string;
  title?: string;
  outgoingEdgeCount: number;
  safeNavigationEdgeCount: number;
  writeRiskEdgeCount: number;
}

export interface ExplorationGraphActionView {
  edgeId: string;
  fromNodeId: string;
  label: string;
  href?: string;
  actionKind: string;
  writeRisk: string;
  warnings: string[];
  toUrl?: string;
}

export interface ExplorationGraphOpenResult {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  runDir: string;
  taskId: TaskId;
  opened: "node" | "action";
  nodeId?: string;
  edgeId?: string;
  expectedUrl: string;
  actualUrl: string;
  title?: string;
  deterministic: boolean;
  browser: Awaited<ReturnType<typeof closeTaskBrowser>>;
}

export interface ExplorationActionExecutionResult {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  runDir: string;
  taskId: TaskId;
  edgeId: string;
  fromNodeId: string;
  actionKind: string;
  selector?: string;
  selectorKind?: string;
  inputValueLength?: number;
  committed?: boolean;
  beforeUrl: string;
  actualUrl: string;
  title?: string;
  deterministic: boolean;
  matchedNodeId?: string;
  browser: Awaited<ReturnType<typeof closeTaskBrowser>>;
}

export interface ExplorationChainStepResult {
  stepIndex: number;
  step: string;
  kind: "node" | "action";
  nodeId?: string;
  edgeId?: string;
  fromNodeId?: string;
  expectedUrl: string;
  actualUrl: string;
  title?: string;
  selector?: string;
  selectorKind?: string;
  inputValueLength?: number;
  committed?: boolean;
  deterministic: boolean;
  matchedNodeId?: string;
}

export interface ExplorationChainResult {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  runDir: string;
  taskId: TaskId;
  deterministic: boolean;
  steps: ExplorationChainStepResult[];
  browser: Awaited<ReturnType<typeof closeTaskBrowser>>;
}

export interface ExplorationPathResult {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  fromNodeId: string;
  toNodeId: string;
  found: boolean;
  steps: Array<{
    fromNodeId: string;
    edgeId: string;
    label: string;
    href?: string;
    toNodeId: string;
    toUrl: string;
  }>;
  chainSteps: string[];
}

export interface ExplorationProgressView {
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  runId?: string;
  crawlPolicy?: Record<string, unknown>;
  captured?: number;
  queued?: number;
  visitedUrlShapeCount?: number;
  currentUrl?: string;
  currentDepth?: number;
  lastCaptureId?: string;
  failed?: number;
  lastFailure?: Record<string, unknown>;
  retrying?: Record<string, unknown>;
  updatedAt?: string;
}

export async function summarizeExplorationGraph(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationGraphView> {
  const { runDir, graph, graphPath } = await loadExplorationGraph(
    input.domain,
    input.runDir,
  );
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    writeRiskEdgeCount: graph.edges.filter((edge) => edge.writeRisk !== "none")
      .length,
    nodes: graph.nodes.map((node) => nodeView(graph, node.nodeId)),
  };
}

export async function summarizeExplorationProgress(input: {
  domain: Domain;
  runDir?: string;
}): Promise<ExplorationProgressView> {
  const runDir = input.runDir || (await latestExplorationRunDir(input.domain));
  const progressPath = path.join(runDir, "progress.json");
  const progress = await readJsonFile<Omit<ExplorationProgressView, "domain" | "runDir">>(
    progressPath,
  );
  if (!progress) throw new Error(`Missing progress.json in ${runDir}`);
  return {
    ...progress,
    schemaVersion: 1,
    domain: input.domain,
    runDir,
  };
}

export async function findExplorationPath(input: {
  domain: Domain;
  fromNodeId: string;
  toNodeId: string;
  runDir?: string;
}): Promise<ExplorationPathResult> {
  const { runDir, graph, graphPath } = await loadExplorationGraph(
    input.domain,
    input.runDir,
  );
  if (!graph.nodes.some((node) => node.nodeId === input.fromNodeId)) {
    throw new Error(`Unknown exploration graph node: ${input.fromNodeId}`);
  }
  if (!graph.nodes.some((node) => node.nodeId === input.toNodeId)) {
    throw new Error(`Unknown exploration graph node: ${input.toNodeId}`);
  }

  const queue: Array<{ nodeId: string; path: ExplorationPathResult["steps"] }> = [
    { nodeId: input.fromNodeId, path: [] },
  ];
  const visited = new Set<string>([input.fromNodeId]);
  const topology = resolveExplorationTopology({
    domain: input.domain,
    runDir,
    graphPath,
    graph,
  });
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    if (current.nodeId === input.toNodeId) {
      return pathResult({
        domain: input.domain,
        runDir,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        steps: current.path,
      });
    }
    for (const edge of topology.canonicalNavigationEdges.filter(
      (candidate) => candidate.fromNodeId === current.nodeId,
    )) {
      const toNodeId = edge.toNodeId;
      if (visited.has(toNodeId)) continue;
      visited.add(toNodeId);
      queue.push({
        nodeId: toNodeId,
        path: [
          ...current.path,
          {
            fromNodeId: current.nodeId,
            edgeId: edge.edgeId,
            label: edge.label,
            href: edge.href,
            toNodeId,
            toUrl: edge.toUrl,
          },
        ],
      });
    }
  }
  return pathResult({
    domain: input.domain,
    runDir,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    steps: [],
  });
}

export async function inspectExplorationNode(input: {
  domain: Domain;
  nodeId: string;
  runDir?: string;
}): Promise<{
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  node: ExplorationGraphNodeView;
  actions: ExplorationGraphActionView[];
}> {
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  const node = graph.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (!node) throw new Error(`Unknown exploration graph node: ${input.nodeId}`);
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir,
    node: nodeView(graph, input.nodeId),
    actions: actionsForNode(graph, input.nodeId),
  };
}

export async function inspectExplorationActions(input: {
  domain: Domain;
  nodeId: string;
  runDir?: string;
}): Promise<{
  schemaVersion: 1;
  domain: Domain;
  runDir: string;
  nodeId: string;
  actions: ExplorationGraphActionView[];
}> {
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  return {
    schemaVersion: 1,
    domain: input.domain,
    runDir,
    nodeId: input.nodeId,
    actions: actionsForNode(graph, input.nodeId),
  };
}

export async function openExplorationNode(input: {
  domain: Domain;
  nodeId: string;
  runDir?: string;
  profile?: string;
}): Promise<ExplorationGraphOpenResult> {
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  const node = graph.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (!node) throw new Error(`Unknown exploration graph node: ${input.nodeId}`);
  return openExplorationUrl({
    domain: input.domain,
    profile: input.profile,
    runDir,
    opened: "node",
    nodeId: input.nodeId,
    expectedUrl: node.url,
  });
}

export async function openExplorationAction(input: {
  domain: Domain;
  edgeId: string;
  runDir?: string;
  profile?: string;
}): Promise<ExplorationGraphOpenResult> {
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  const edge = graph.edges.find((candidate) => candidate.edgeId === input.edgeId);
  if (!edge) throw new Error(`Unknown exploration graph action: ${input.edgeId}`);
  if (edge.actionKind !== "navigate" || !edge.href) {
    throw new Error(`Exploration graph action ${input.edgeId} is not navigable`);
  }
  if (edge.writeRisk !== "none") {
    throw new Error(`Exploration graph action ${input.edgeId} has write risk`);
  }
  const fromNode = graph.nodes.find((node) => node.nodeId === edge.fromNodeId);
  if (!fromNode) throw new Error(`Missing from node for action: ${input.edgeId}`);
  const expectedUrl = new URL(edge.href, fromNode.url).toString();
  return openExplorationUrl({
    domain: input.domain,
    profile: input.profile,
    runDir,
    opened: "action",
    edgeId: input.edgeId,
    nodeId: edge.fromNodeId,
    expectedUrl,
  });
}

export async function executeExplorationAction(input: {
  domain: Domain;
  edgeId: string;
  runDir?: string;
  profile?: string;
  value?: string;
  commit?: boolean;
}): Promise<ExplorationActionExecutionResult> {
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  const edge = graph.edges.find((candidate) => candidate.edgeId === input.edgeId);
  if (!edge) throw new Error(`Unknown exploration graph action: ${input.edgeId}`);
  if (edge.writeRisk !== "none" && !isExplicitValueAction(edge, input.value)) {
    throw new Error(`Exploration graph action ${input.edgeId} has write risk`);
  }
  const fromNode = graph.nodes.find((node) => node.nodeId === edge.fromNodeId);
  if (!fromNode) throw new Error(`Missing from node for action: ${input.edgeId}`);
  if (edge.actionKind === "navigate") {
    const opened = await openExplorationAction(input);
    return {
      schemaVersion: 1,
      domain: opened.domain,
      profile: opened.profile,
      runDir: opened.runDir,
      taskId: opened.taskId,
      edgeId: input.edgeId,
      fromNodeId: edge.fromNodeId,
      actionKind: edge.actionKind,
      beforeUrl: fromNode.url,
      actualUrl: opened.actualUrl,
      title: opened.title,
      deterministic: opened.deterministic,
      matchedNodeId: nodeIdForUrl(graph, opened.actualUrl),
      browser: opened.browser,
    };
  }
  if (
    edge.actionKind !== "click" &&
    edge.actionKind !== "input" &&
    edge.actionKind !== "select"
  ) {
    throw new Error(
      `Exploration graph action ${input.edgeId} is ${edge.actionKind}; only navigate, safe click, explicit input, and explicit select are executable`,
    );
  }
  if ((edge.actionKind === "input" || edge.actionKind === "select") && input.value === undefined) {
    throw new Error(
      `Exploration graph action ${input.edgeId} requires --value for ${edge.actionKind}`,
    );
  }

  const profile = input.profile || "default";
  const taskId = uniqueTaskId("exploration-exec");
  return withBrowserProfileLock(input.domain, profile, async () => {
    const connection = await connectOrStartTaskBrowser(
      input.domain,
      taskId,
      profile,
    );
    try {
      await connection.page.goto(fromNode.url, { waitUntil: "domcontentloaded" });
      await connection.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const selector =
        edge.actionKind === "click"
          ? await clickEdgeControl(connection.page, edge)
          : edge.actionKind === "input"
            ? await fillEdgeControl(connection.page, edge, input.value || "", {
                commit: input.commit === true,
              })
            : await selectEdgeControl(connection.page, edge, input.value || "");
      await connection.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      const actualUrl = connection.page.url();
      const title = await connection.page.title().catch((): undefined => undefined);
      const matchedNodeId = nodeIdForUrl(graph, actualUrl);
      const browser = await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      return {
        schemaVersion: 1,
        domain: input.domain,
        profile,
        runDir,
        taskId,
        edgeId: edge.edgeId,
        fromNodeId: edge.fromNodeId,
        actionKind: edge.actionKind,
        selector: selector.selector,
        selectorKind: selector.kind,
        inputValueLength:
          edge.actionKind === "input" || edge.actionKind === "select"
            ? (input.value || "").length
            : undefined,
        committed: edge.actionKind === "input" ? input.commit === true : undefined,
        beforeUrl: fromNode.url,
        actualUrl,
        title,
        deterministic:
          equivalentUrl(fromNode.url, actualUrl) || Boolean(matchedNodeId),
        matchedNodeId,
        browser,
      };
    } catch (error) {
      await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      throw error;
    }
  });
}

export async function runExplorationChain(input: {
  domain: Domain;
  steps: string[];
  runDir?: string;
  profile?: string;
}): Promise<ExplorationChainResult> {
  if (!input.steps.length) {
    throw new Error("Exploration chain requires at least one step");
  }
  const { runDir, graph } = await loadExplorationGraph(input.domain, input.runDir);
  const profile = input.profile || "default";
  const taskId = uniqueTaskId("exploration-chain");
  return withBrowserProfileLock(input.domain, profile, async () => {
    const connection = await connectOrStartTaskBrowser(
      input.domain,
      taskId,
      profile,
    );
    const results: ExplorationChainStepResult[] = [];
    let currentNodeId: string | undefined;
    try {
      for (let index = 0; index < input.steps.length; index += 1) {
        const step = parseChainStep(input.steps[index]);
        if (step.kind === "node") {
          const node = graph.nodes.find((candidate) => candidate.nodeId === step.id);
          if (!node) throw new Error(`Unknown exploration graph node: ${step.id}`);
          const result = await navigateAndCheck({
            graph,
            page: connection.page,
            expectedUrl: node.url,
          });
          currentNodeId = result.matchedNodeId || node.nodeId;
          results.push({
            stepIndex: index,
            step: input.steps[index],
            kind: "node",
            nodeId: node.nodeId,
            expectedUrl: node.url,
            ...result,
          });
          continue;
        }

        const edge = graph.edges.find((candidate) => candidate.edgeId === step.id);
        if (!edge) throw new Error(`Unknown exploration graph action: ${step.id}`);
        if (step.actionKind && edge.actionKind !== step.actionKind) {
          throw new Error(
            `Chain action ${step.id} was declared as ${step.actionKind}, but graph action is ${edge.actionKind}`,
          );
        }
        if (edge.writeRisk !== "none" && !isExplicitValueAction(edge, step.value)) {
          throw new Error(`Exploration graph action ${step.id} has write risk`);
        }
        if ((edge.actionKind === "input" || edge.actionKind === "select") && step.value === undefined) {
          throw new Error(
            `Chain action ${step.id} requires ${edge.actionKind}:<edge-id>=<value> or action:<edge-id>=<value>`,
          );
        }
        const fromNode = graph.nodes.find((node) => node.nodeId === edge.fromNodeId);
        if (!fromNode) throw new Error(`Missing from node for action: ${step.id}`);
        if (currentNodeId && currentNodeId !== edge.fromNodeId) {
          throw new Error(
            `Chain action ${step.id} starts at ${edge.fromNodeId}, but current node is ${currentNodeId}`,
          );
        }
        if (!currentNodeId) {
          const fromResult = await navigateAndCheck({
            graph,
            page: connection.page,
            expectedUrl: fromNode.url,
          });
          if (!fromResult.deterministic) {
            results.push({
              stepIndex: index,
              step: `node:${fromNode.nodeId}`,
              kind: "node",
              nodeId: fromNode.nodeId,
              expectedUrl: fromNode.url,
              ...fromResult,
            });
            break;
          }
          currentNodeId = fromNode.nodeId;
        }

        const expectedUrl = edge.href ? new URL(edge.href, fromNode.url).toString() : fromNode.url;
        const result =
          edge.actionKind === "navigate" && edge.href
            ? await navigateAndCheck({
                graph,
                page: connection.page,
                expectedUrl,
              })
            : await executeEdgeAndCheck({
                graph,
                page: connection.page,
                edge,
                fromUrl: fromNode.url,
                value: step.value,
              });
        currentNodeId =
          result.matchedNodeId ||
          (result.deterministic && !edge.href ? edge.fromNodeId : undefined);
        results.push({
          stepIndex: index,
          step: input.steps[index],
          kind: "action",
          edgeId: edge.edgeId,
          fromNodeId: edge.fromNodeId,
          expectedUrl,
          ...result,
        });
      }
      const browser = await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      return {
        schemaVersion: 1,
        domain: input.domain,
        profile,
        runDir,
        taskId,
        deterministic: results.every((result) => result.deterministic),
        steps: results,
        browser,
      };
    } catch (error) {
      await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      throw error;
    }
  });
}

async function openExplorationUrl(input: {
  domain: Domain;
  profile?: string;
  runDir: string;
  opened: "node" | "action";
  nodeId?: string;
  edgeId?: string;
  expectedUrl: string;
}): Promise<ExplorationGraphOpenResult> {
  const profile = input.profile || "default";
  const taskId = uniqueTaskId("exploration-open");
  return withBrowserProfileLock(input.domain, profile, async () => {
    const connection = await connectOrStartTaskBrowser(
      input.domain,
      taskId,
      profile,
    );
    try {
      await connection.page.goto(input.expectedUrl, { waitUntil: "domcontentloaded" });
      await connection.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const actualUrl = connection.page.url();
      const title = await connection.page.title().catch((): undefined => undefined);
      const browser = await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      return {
        schemaVersion: 1,
        domain: input.domain,
        profile,
        runDir: input.runDir,
        taskId,
        opened: input.opened,
        nodeId: input.nodeId,
        edgeId: input.edgeId,
        expectedUrl: input.expectedUrl,
        actualUrl,
        title,
        deterministic: equivalentUrl(input.expectedUrl, actualUrl),
        browser,
      };
    } catch (error) {
      await closeTaskBrowser(input.domain, taskId, profile, {
        keepBrowserOpen: true,
      });
      throw error;
    }
  });
}

async function navigateAndCheck(input: {
  graph: GraphCandidate;
  page: Page;
  expectedUrl: string;
}): Promise<{
  actualUrl: string;
  title?: string;
  deterministic: boolean;
  matchedNodeId?: string;
}> {
  await input.page.goto(input.expectedUrl, { waitUntil: "domcontentloaded" });
  await input.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  const actualUrl = input.page.url();
  const title = await input.page.title().catch((): undefined => undefined);
  const matchedNodeId = nodeIdForUrl(input.graph, actualUrl);
  return {
    actualUrl,
    title,
    deterministic: equivalentUrl(input.expectedUrl, actualUrl),
    matchedNodeId,
  };
}

async function executeEdgeAndCheck(input: {
  graph: GraphCandidate;
  page: Page;
  edge: CandidateEdge;
  fromUrl: string;
  value?: string;
}): Promise<{
  actualUrl: string;
  title?: string;
  selector?: string;
  selectorKind?: string;
  inputValueLength?: number;
  committed?: boolean;
  deterministic: boolean;
  matchedNodeId?: string;
}> {
  if (
    input.edge.actionKind !== "click" &&
    input.edge.actionKind !== "input" &&
    input.edge.actionKind !== "select"
  ) {
    throw new Error(`Chain action ${input.edge.edgeId} is not executable`);
  }
  if (
    (input.edge.actionKind === "input" || input.edge.actionKind === "select") &&
    input.value === undefined
  ) {
    throw new Error(
      `Chain action ${input.edge.edgeId} requires an explicit value for ${input.edge.actionKind}`,
    );
  }
  const selector =
    input.edge.actionKind === "click"
      ? await clickEdgeControl(input.page, input.edge)
      : input.edge.actionKind === "input"
        ? await fillEdgeControl(input.page, input.edge, input.value || "", {
            commit: false,
          })
        : await selectEdgeControl(input.page, input.edge, input.value || "");
  await input.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  const actualUrl = input.page.url();
  const title = await input.page.title().catch((): undefined => undefined);
  const matchedNodeId = nodeIdForUrl(input.graph, actualUrl);
  return {
    actualUrl,
    title,
    selector: selector.selector,
    selectorKind: selector.kind,
    inputValueLength:
      input.edge.actionKind === "input" || input.edge.actionKind === "select"
        ? (input.value || "").length
        : undefined,
    committed: input.edge.actionKind === "input" ? false : undefined,
    deterministic: equivalentUrl(input.fromUrl, actualUrl) || Boolean(matchedNodeId),
    matchedNodeId,
  };
}

function isExplicitValueAction(edge: CandidateEdge, value: string | undefined): boolean {
  return (
    (edge.actionKind === "input" || edge.actionKind === "select") &&
    value !== undefined
  );
}

function nodeView(graph: GraphCandidate, nodeId: string): ExplorationGraphNodeView {
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Unknown exploration graph node: ${nodeId}`);
  const outgoing = graph.edges.filter((edge) => edge.fromNodeId === nodeId);
  return {
    nodeId: node.nodeId,
    surfaceType: node.surfaceType,
    url: node.url,
    urlShape: node.urlShape,
    title: node.title,
    outgoingEdgeCount: outgoing.length,
    safeNavigationEdgeCount: outgoing.filter(
      (edge) => edge.actionKind === "navigate" && edge.writeRisk === "none",
    ).length,
    writeRiskEdgeCount: outgoing.filter((edge) => edge.writeRisk !== "none").length,
  };
}

function actionsForNode(
  graph: GraphCandidate,
  nodeId: string,
): ExplorationGraphActionView[] {
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  return graph.edges
    .filter((edge) => edge.fromNodeId === nodeId)
    .sort((a, b) => b.priority - a.priority)
    .map((edge) => ({
      edgeId: edge.edgeId,
      fromNodeId: edge.fromNodeId,
      label: edge.label,
      href: edge.href,
      actionKind: edge.actionKind,
      writeRisk: edge.writeRisk,
      warnings: edge.warnings,
      toUrl: edge.href && node ? new URL(edge.href, node.url).toString() : undefined,
    }));
}

async function fillEdgeControl(
  page: Page,
  edge: CandidateEdge,
  value: string,
  options: { commit: boolean },
): Promise<{ selector: string; kind: string }> {
  const candidates = edge.selectorCandidates.filter(
    (candidate) => candidate.kind === "role" || candidate.kind === "css",
  );
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const locator = locatorForCandidate(page, candidate.selector).first();
      await locator.fill(value, { timeout: 5000 });
      if (options.commit) await locator.press("Enter", { timeout: 3000 });
      return { selector: candidate.selector, kind: candidate.kind };
    } catch (error) {
      failures.push(
        `${candidate.selector}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Unable to fill exploration action ${edge.edgeId}; selectors failed: ${failures.join(" | ")}`,
  );
}

async function selectEdgeControl(
  page: Page,
  edge: CandidateEdge,
  value: string,
): Promise<{ selector: string; kind: string }> {
  const candidates = edge.selectorCandidates.filter(
    (candidate) => candidate.kind === "role" || candidate.kind === "css",
  );
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const locator = locatorForCandidate(page, candidate.selector).first();
      await locator.selectOption({ label: value }, { timeout: 5000 });
      return { selector: candidate.selector, kind: candidate.kind };
    } catch (labelError) {
      try {
        const locator = locatorForCandidate(page, candidate.selector).first();
        await locator.selectOption(value, { timeout: 5000 });
        return { selector: candidate.selector, kind: candidate.kind };
      } catch (valueError) {
        failures.push(
          `${candidate.selector}: label=${labelError instanceof Error ? labelError.message : String(labelError)}; value=${valueError instanceof Error ? valueError.message : String(valueError)}`,
        );
      }
    }
  }
  throw new Error(
    `Unable to select exploration action ${edge.edgeId}; selectors failed: ${failures.join(" | ")}`,
  );
}

async function clickEdgeControl(
  page: Page,
  edge: CandidateEdge,
): Promise<{ selector: string; kind: string }> {
  const candidates = edge.selectorCandidates.filter(
    (candidate) => candidate.kind === "role" || candidate.kind === "css" || candidate.kind === "text",
  );
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const locator = locatorForCandidate(page, candidate.selector);
      await locator.first().click({ timeout: 5000 });
      return { selector: candidate.selector, kind: candidate.kind };
    } catch (error) {
      failures.push(
        `${candidate.selector}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Unable to click exploration action ${edge.edgeId}; selectors failed: ${failures.join(" | ")}`,
  );
}

function locatorForCandidate(page: Page, selector: string) {
  const roleMatch = selector.match(/^role=([^\[]+)\[name=(.*)\]$/);
  if (roleMatch) {
    const role = roleMatch[1] as Parameters<Page["getByRole"]>[0];
    const name = JSON.parse(roleMatch[2]) as string;
    return page.getByRole(role, { name });
  }
  if (selector.startsWith("text=")) {
    return page.getByText(selector.slice("text=".length));
  }
  return page.locator(selector);
}

function parseChainStep(step: string): {
  kind: "node" | "action";
  id: string;
  value?: string;
  actionKind?: "input" | "select";
} {
  if (step.startsWith("node:")) return { kind: "node", id: step.slice("node:".length) };
  if (step.startsWith("action:"))
    return parseActionChainStep(step.slice("action:".length));
  if (step.startsWith("edge:"))
    return parseActionChainStep(step.slice("edge:".length));
  if (step.startsWith("input:"))
    return {
      ...parseActionChainStep(step.slice("input:".length)),
      actionKind: "input",
    };
  if (step.startsWith("select:"))
    return {
      ...parseActionChainStep(step.slice("select:".length)),
      actionKind: "select",
    };
  throw new Error(
    `Invalid chain step: ${step}. Use node:<node-id>, action:<edge-id>, input:<edge-id>=<value>, or select:<edge-id>=<value>.`,
  );
}

function parseActionChainStep(step: string): {
  kind: "action";
  id: string;
  value?: string;
} {
  const valueSeparator = step.indexOf("=");
  if (valueSeparator === -1) return { kind: "action", id: step };
  return {
    kind: "action",
    id: step.slice(0, valueSeparator),
    value: step.slice(valueSeparator + 1),
  };
}

function nodeIdForUrl(graph: GraphCandidate, url: string): string | undefined {
  return findExplorationNodeForUrl(graph, url)?.nodeId;
}

function pathResult(input: {
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

async function loadExplorationGraph(
  domain: Domain,
  runDir?: string,
): Promise<{ runDir: string; graph: GraphCandidate; graphPath: string }> {
  const resolvedRunDir = runDir || (await latestExplorationRunDir(domain));
  const graphPath = path.join(resolvedRunDir, "graph-candidate.json");
  const graph = await readJsonFile<GraphCandidate>(graphPath);
  if (!graph) throw new Error(`Missing graph-candidate.json in ${resolvedRunDir}`);
  return { runDir: resolvedRunDir, graph, graphPath };
}

async function latestExplorationRunDir(domain: Domain): Promise<string> {
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

function equivalentUrl(expected: string, actual: string): boolean {
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  expectedUrl.hash = "";
  actualUrl.hash = "";
  return expectedUrl.toString() === actualUrl.toString();
}

function uniqueTaskId(prefix: string): TaskId {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
