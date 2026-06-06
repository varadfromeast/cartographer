import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  FallbackOperation,
  FallbackTape,
  Postcondition,
  ProcessOutput,
  ProcessTapeSummary,
  SnapshotControlSummary,
  TapeCatalog,
} from "./contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import { JsonFallbackTapeStore } from "./fallback-store.js";
import { JsonTapeStore } from "./tape-store.js";
import {
  siteGraphJsonPath,
  siteGraphMarkdownPath,
  slugifyName,
  surfacePacketPath,
} from "./paths.js";
import { emitSurfacePackets } from "./surface-packet.js";

export type SiteGraphRisk =
  | "safe_navigation"
  | "read"
  | "write"
  | "write_submit"
  | "destructive"
  | "unknown";

export type SiteGraphTrust =
  | "trusted_cli"
  | "observed"
  | "weak"
  | "rerecord_required"
  | "failed";

export interface SiteGraph {
  schemaVersion: 1;
  domain: Domain;
  generatedAt: string;
  sources: {
    fallbackTapeCount: number;
    catalogProcessCount: number;
    includeRejected: boolean;
  };
  nodes: SiteGraphNode[];
  actions: SiteGraphAction[];
  workflows: SiteGraphWorkflow[];
}

export interface SiteGraphNode {
  id: string;
  surfaceKind: string;
  summary: string;
  urlShapes: string[];
  signals: string[];
  evidenceCount: number;
  evidenceRefs: string[];
  surfacePacketPath?: string;
}

export interface SiteGraphAction {
  id: string;
  from: string;
  to: string;
  summary: string;
  risk: SiteGraphRisk;
  trust: SiteGraphTrust;
  implementation: SiteGraphImplementation;
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  evidenceCount: number;
  evidenceRefs: string[];
  executableByAgent: boolean;
  writeConfirmationRequired?: boolean;
  whyNotExecutable?: string;
}

export type SiteGraphImplementation =
  | {
      type: "cli";
      processName: string;
      command: string;
      args: string[];
    }
  | {
      type: "fallback_observed";
      status: "not_trusted";
      reason: string;
    }
  | {
      type: "none";
      reason: string;
    };

export interface SiteGraphWorkflow {
  id: string;
  summary: string;
  steps: string[];
  automationReadiness: "ready" | "partial" | "blocked";
  blockingActions: string[];
}

interface NodeAccumulator {
  id: string;
  surfaceKind: string;
  summary: string;
  urlShapes: Set<string>;
  signals: Map<string, number>;
  evidenceRefs: Set<string>;
}

interface ActionAccumulator {
  id: string;
  from: string;
  to: string;
  summary: string;
  risk: SiteGraphRisk;
  trust: SiteGraphTrust;
  implementation: SiteGraphImplementation;
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  evidenceRefs: Set<string>;
}

export async function analyzeSiteGraph(input: {
  domain: Domain;
  includeRejected?: boolean;
}): Promise<{
  graph: SiteGraph;
  jsonPath: string;
  markdownPath: string;
}> {
  const includeRejected = input.includeRejected ?? true;
  const fallbackStore = new JsonFallbackTapeStore();
  const tapeStore = new JsonTapeStore();
  const catalog = await tapeStore.loadCatalog(input.domain);
  const tapes = (await fallbackStore.list(input.domain)).filter((tape) =>
    includeRejected ? true : tape.status !== "rejected",
  );
  const graph = buildSiteGraph({
    domain: input.domain,
    tapes,
    catalog,
    includeRejected,
  });
  const jsonPath = siteGraphJsonPath(input.domain);
  const markdownPath = siteGraphMarkdownPath(input.domain);
  await writeJsonFile(jsonPath, graph);
  await ensureDir(path.dirname(markdownPath));
  await fs.writeFile(markdownPath, renderSiteGraphMarkdown(graph), "utf8");
  await emitSurfacePackets({ domain: input.domain, graph, tapes });
  return { graph, jsonPath, markdownPath };
}

export async function loadSiteGraph(domain: Domain): Promise<SiteGraph | null> {
  return await readJsonFile<SiteGraph>(siteGraphJsonPath(domain));
}

export function buildSiteGraph(input: {
  domain: Domain;
  tapes: FallbackTape[];
  catalog: TapeCatalog | null;
  includeRejected: boolean;
}): SiteGraph {
  const nodes = new Map<string, NodeAccumulator>();
  const actions = new Map<string, ActionAccumulator>();

  const ensureNode = (
    url: string | undefined,
    evidenceRef: string,
    surfaceHint?: ReturnType<typeof surfaceFromUrl>,
  ): string => {
    const surface = surfaceHint || surfaceFromUrl(url);
    const existing = nodes.get(surface.id);
    if (existing) {
      if (surface.urlShape) existing.urlShapes.add(surface.urlShape);
      existing.evidenceRefs.add(evidenceRef);
      return existing.id;
    }
    nodes.set(surface.id, {
      id: surface.id,
      surfaceKind: surface.kind,
      summary: surface.summary,
      urlShapes: new Set(surface.urlShape ? [surface.urlShape] : []),
      signals: new Map(),
      evidenceRefs: new Set([evidenceRef]),
    });
    return surface.id;
  };

  for (const tape of input.tapes) {
    const tapeRef = `fallback:${tape.id}`;
    ensureNode(tape.entry?.url, tapeRef);
    for (const operation of tape.operations || []) {
      const opRef = evidenceRefForOperation(tape, operation);
      const before = ensureNode(
        operation.urlBefore || operation.urlAfter || tape.entry?.url,
        opRef,
        surfaceFromOperation(operation, "before", tape.entry?.url),
      );
      const after = ensureNode(
        operation.urlAfter || operation.urlBefore || tape.entry?.url,
        opRef,
        surfaceFromOperation(operation, "after", tape.entry?.url),
      );
      addControlSignals(nodes.get(after), operation.evidenceSummary?.controls);
      if (!isActionOperation(operation)) continue;
      const id = actionId(operation, before, after);
      const existing = actions.get(id);
      const candidate = actionFromOperation(operation, before, after, opRef);
      if (existing) {
        existing.evidenceRefs.add(opRef);
        existing.trust = mergeTrust(existing.trust, candidate.trust);
        existing.risk = mergeRisk(existing.risk, candidate.risk);
      } else {
        actions.set(candidate.id, candidate);
      }
    }
  }

  for (const process of Object.values(input.catalog?.processes || {})) {
    const edge = cliActionFromProcess(process);
    if (!edge) continue;
    const fromNode = nodes.get(edge.from) || defaultNode(edge.from);
    const toNode = nodes.get(edge.to) || defaultNode(edge.to);
    nodes.set(fromNode.id, fromNode);
    nodes.set(toNode.id, toNode);
    actions.set(edge.id, {
      ...edge,
      evidenceRefs: new Set(edge.evidenceRefs),
    });
  }

  const graphActions = [...actions.values()]
    .map(finalizeAction)
    .sort((a, b) => a.id.localeCompare(b.id));
  const graphNodes = [...nodes.values()]
    .map(finalizeNode)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion: 1,
    domain: input.domain,
    generatedAt: new Date().toISOString(),
    sources: {
      fallbackTapeCount: input.tapes.length,
      catalogProcessCount: Object.keys(input.catalog?.processes || {}).length,
      includeRejected: input.includeRejected,
    },
    nodes: graphNodes,
    actions: graphActions,
    workflows: synthesizeWorkflows(graphActions),
  };
}

export function renderSiteGraphMarkdown(graph: SiteGraph): string {
  const lines = [
    `# ${graph.domain} Site Graph`,
    "",
    `Generated: ${graph.generatedAt}`,
    `Sources: ${graph.sources.fallbackTapeCount} fallback tapes, ${graph.sources.catalogProcessCount} trusted commands`,
    "",
    "## Surfaces",
    "",
  ];
  for (const node of graph.nodes) {
    lines.push(`### ${node.id}`);
    lines.push(node.summary);
    if (node.urlShapes.length) lines.push(`URLs: ${node.urlShapes.join(", ")}`);
    if (node.signals.length) lines.push(`Signals: ${node.signals.join(", ")}`);
    const outgoing = graph.actions.filter((action) => action.from === node.id);
    const trusted = outgoing.filter((action) => action.trust === "trusted_cli");
    const observed = outgoing.filter(
      (action) => action.trust !== "trusted_cli",
    );
    if (trusted.length) {
      lines.push("", "Trusted actions:");
      for (const action of trusted) lines.push(`- ${actionLine(action)}`);
    }
    if (observed.length) {
      lines.push("", "Observed actions:");
      for (const action of observed.slice(0, 8))
        lines.push(`- ${actionLine(action)}`);
    }
    lines.push("");
  }
  if (graph.workflows.length) {
    lines.push("## Workflows", "");
    for (const workflow of graph.workflows) {
      lines.push(`### ${workflow.id}`);
      lines.push(workflow.summary);
      lines.push(`Readiness: ${workflow.automationReadiness}`);
      lines.push(`Steps: ${workflow.steps.join(" -> ")}`);
      if (workflow.blockingActions.length) {
        lines.push(`Blocking actions: ${workflow.blockingActions.join(", ")}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function actionLine(action: SiteGraphAction): string {
  const impl =
    action.implementation.type === "cli"
      ? ` command: cg exec-command instagram ${commandSlug(action.implementation.processName)}`
      : "";
  const blocked = action.executableByAgent
    ? ""
    : ` not executable: ${action.whyNotExecutable}`;
  return `${action.id} -> ${action.to} [${action.risk}, ${action.trust}]${impl}${blocked}`;
}

function isActionOperation(operation: FallbackOperation): boolean {
  return [
    "open",
    "goto",
    "click",
    "dblclick",
    "fill",
    "type",
    "press",
    "check",
    "uncheck",
    "select",
    "upload",
    "cli",
  ].includes(operation.kind);
}

function actionFromOperation(
  operation: FallbackOperation,
  from: string,
  to: string,
  evidenceRef: string,
): ActionAccumulator {
  const risk = riskForOperation(operation);
  const trust = trustForOperation(operation);
  const summary = summaryForOperation(operation);
  const implementation: SiteGraphImplementation =
    operation.processName && operation.surface === "cli"
      ? {
          type: "cli",
          processName: operation.processName,
          command: `cg exec-command instagram ${commandSlug(operation.processName)}`,
          args: operation.commandArgs || [],
        }
      : {
          type: "fallback_observed",
          status: "not_trusted",
          reason:
            trust === "failed"
              ? compactFailureReason(operation.failureReason)
              : "observed in fallback evidence only",
        };
  return {
    id: actionId(operation, from, to),
    from,
    to,
    summary,
    risk,
    trust,
    implementation,
    evidenceRefs: new Set([evidenceRef]),
  };
}

function actionId(
  operation: FallbackOperation,
  from: string,
  to: string,
): string {
  const name =
    operation.processName ||
    commandLikeName(operation) ||
    `${operation.kind}_${from}_to_${to}`;
  return `action.${slugifyName(name).replace(/-/g, "_")}`;
}

function commandLikeName(operation: FallbackOperation): string {
  const source =
    `${operation.selector || ""} ${operation.instruction || ""}`.toLowerCase();
  if (operation.kind === "goto" || operation.kind === "open") {
    const surface = surfaceFromUrl(operation.urlAfter || operation.urlBefore);
    return `open_${surface.id}`;
  }
  if (source.includes("send")) return "send_message_current_thread";
  if (source.includes("search")) return `${operation.kind}_search`;
  if (source.includes("conversation information"))
    return "open_conversation_information";
  if (operation.kind === "fill" && source.includes("contenteditable")) {
    return "fill_message_composer";
  }
  return "";
}

function summaryForOperation(operation: FallbackOperation): string {
  if (operation.processName) return commandTitle(operation.processName);
  if (operation.kind === "goto" || operation.kind === "open") {
    return `Open ${surfaceFromUrl(operation.urlAfter || operation.urlBefore).summary}`;
  }
  if (operation.kind === "fill" || operation.kind === "type") {
    return "Enter text into a visible field";
  }
  if (operation.kind === "press") return "Press a key in the current state";
  if (operation.kind === "click" || operation.kind === "dblclick") {
    const source = `${operation.selector || ""} ${operation.instruction || ""}`;
    if (/send/i.test(source)) return "Submit the current composer";
    if (/thread|user avatar|profile picture/i.test(source))
      return "Open a visible row or profile target";
    return "Click a visible control";
  }
  return `${operation.kind} action`;
}

function riskForOperation(operation: FallbackOperation): SiteGraphRisk {
  const source =
    `${operation.selector || ""} ${operation.instruction || ""}`.toLowerCase();
  if (/\b(delete|remove|block|unfollow)\b/.test(source)) return "destructive";
  if (
    operation.writesToPlatform &&
    /\b(send|submit|post|publish|save)\b/.test(source)
  ) {
    return "write_submit";
  }
  if (operation.writesToPlatform) return "write";
  if (operation.kind === "snapshot" || operation.kind === "text") return "read";
  if (operation.kind === "goto" || operation.kind === "open") {
    return "safe_navigation";
  }
  if (
    (operation.kind === "click" || operation.kind === "dblclick") &&
    operation.urlBefore &&
    operation.urlAfter &&
    operation.urlBefore !== operation.urlAfter
  ) {
    return "safe_navigation";
  }
  return "unknown";
}

function trustForOperation(operation: FallbackOperation): SiteGraphTrust {
  if (operation.success === false || operation.failureReason) return "failed";
  if (operation.surface === "cli" && operation.processName)
    return "trusted_cli";
  if (operation.writeGrounding?.promotionReady === false) {
    return operation.writesToPlatform ? "rerecord_required" : "weak";
  }
  if (
    operation.evidenceSummary?.warnings?.some((warning) =>
      /weak|rerecord|raw_snapshot_ref|no_durable/.test(warning),
    )
  ) {
    return operation.writesToPlatform ? "rerecord_required" : "weak";
  }
  return "observed";
}

function compactFailureReason(reason: string | undefined): string {
  if (!reason?.trim()) return "operation failed";
  const firstMeaningfulLine = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.includes("node_modules"));
  return (firstMeaningfulLine || "operation failed").slice(0, 180);
}

function cliActionFromProcess(
  process: ProcessTapeSummary,
):
  | (Omit<ActionAccumulator, "evidenceRefs"> & { evidenceRefs: string[] })
  | null {
  const name = process.name;
  const to = processToSurface(name);
  if (!to) return null;
  const explicitFrom = processFromSurface(name);
  const stateScopeValue = process.stateScope?.preconditions?.find(
    (item) => "value" in item,
  )?.value;
  const from = explicitFrom
    ? explicitFrom
    : stateScopeValue
      ? surfaceFromUrl(stateScopeValue).id
      : "any_authenticated_state";
  const risk: SiteGraphRisk = process.writesToPlatform
    ? "write_submit"
    : process.outputs?.length
      ? "read"
      : "safe_navigation";
  return {
    id: `action.${name}`,
    from,
    to,
    summary: process.description || commandTitle(name),
    risk,
    trust: "trusted_cli",
    implementation: {
      type: "cli",
      processName: name,
      command: `cg exec-command instagram ${commandSlug(name)}`,
      args: process.args.map((arg) => arg.name),
    },
    outputs: process.outputs || [],
    postconditions: process.postconditions || [],
    evidenceRefs: [`catalog:${name}`],
  };
}

function processToSurface(name: string): string | undefined {
  if (name === "open_inbox") return "direct_inbox";
  if (name === "open_notifications") return "notifications_panel";
  if (name === "open_thread_by_name") return "direct_thread";
  if (name === "open_profile_by_username") return "profile";
  if (name === "read_current_notifications_summary")
    return "notifications_panel";
  if (name === "send_message_current_thread") return "composer_ready";
  if (name === "read_current_profile_summary") return "profile";
  return undefined;
}

function processFromSurface(name: string): string | undefined {
  if (name === "read_current_profile_summary") return "profile";
  if (name === "read_current_notifications_summary")
    return "notifications_panel";
  if (name === "send_message_current_thread") return "direct_thread";
  return undefined;
}

function surfaceFromOperation(
  operation: FallbackOperation,
  phase: "before" | "after",
  fallbackUrl?: string,
): ReturnType<typeof surfaceFromUrl> {
  const url =
    phase === "before"
      ? operation.urlBefore || operation.urlAfter || fallbackUrl
      : operation.urlAfter || operation.urlBefore || fallbackUrl;
  const source = [
    operation.kind,
    operation.selector || "",
    operation.instruction || "",
    ...(operation.commandArgs || []),
    ...(operation.evidenceSummary?.controls || []).map(
      (control) => `${control.role} ${control.name || ""}`,
    ),
  ]
    .join(" ")
    .toLowerCase();
  if (/notifications|this week|this month|started following you/.test(source)) {
    return {
      id: "notifications_panel",
      kind: "notifications_panel",
      summary: "Instagram notifications panel",
      urlShape: url?.includes("/direct/t/")
        ? "/direct/t/:threadId/"
        : url
          ? surfaceFromUrl(url).urlShape
          : undefined,
    };
  }
  if (url?.includes("/direct/inbox")) {
    if (
      phase === "after" &&
      ((operation.kind === "fill" && /search/.test(source)) ||
        /clear search|matched messages|more accounts/.test(source))
    ) {
      return {
        id: /more accounts/.test(source)
          ? "account_search_results"
          : "direct_search_results",
        kind: "search_results",
        summary: "Instagram direct search results",
        urlShape: "/direct/inbox/",
      };
    }
    if (
      phase === "before" &&
      /clear search|matched messages|more accounts/.test(source)
    ) {
      return {
        id: /more accounts/.test(source)
          ? "account_search_results"
          : "direct_search_results",
        kind: "search_results",
        summary: "Instagram direct search results",
        urlShape: "/direct/inbox/",
      };
    }
  }
  if (url?.includes("/direct/t/")) {
    if (/conversation information/.test(source)) {
      return {
        id: phase === "after" ? "conversation_information" : "direct_thread",
        kind: phase === "after" ? "conversation_information" : "direct_thread",
        summary:
          phase === "after"
            ? "Instagram conversation information panel"
            : "Instagram direct-message thread",
        urlShape: "/direct/t/:threadId/",
      };
    }
    if (
      phase === "after" &&
      /message\.\.\.|voice clip|choose an emoji|role=textbox|send/.test(source)
    ) {
      return {
        id: "composer_ready",
        kind: "composer_ready",
        summary: "Instagram direct-message composer",
        urlShape: "/direct/t/:threadId/",
      };
    }
  }
  return surfaceFromUrl(url);
}

function surfaceFromUrl(url: string | undefined): {
  id: string;
  kind: string;
  summary: string;
  urlShape?: string;
} {
  if (!url) {
    return {
      id: "unknown_surface",
      kind: "unknown",
      summary: "Unknown browser surface",
    };
  }
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // url may already be a path or postcondition fragment.
  }
  if (pathname.includes("/direct/inbox")) {
    return {
      id: "direct_inbox",
      kind: "direct_inbox",
      summary: "Instagram direct inbox",
      urlShape: "/direct/inbox/",
    };
  }
  if (pathname.includes("/direct/t/")) {
    return {
      id: "direct_thread",
      kind: "direct_thread",
      summary: "Instagram direct-message thread",
      urlShape: "/direct/t/:threadId/",
    };
  }
  if (pathname.includes("/explore")) {
    return {
      id: "explore",
      kind: "explore",
      summary: "Instagram Explore",
      urlShape: "/explore/",
    };
  }
  const profile = pathname.match(/^\/[A-Za-z0-9._]+\/?$/);
  if (
    profile &&
    !/^\/(?:accounts|direct|explore|p|reel|stories)\b/.test(pathname)
  ) {
    return {
      id: "profile",
      kind: "profile",
      summary: "Instagram profile",
      urlShape: "/:username/",
    };
  }
  if (pathname === "/" || pathname === "") {
    return {
      id: "home",
      kind: "home",
      summary: "Instagram home",
      urlShape: "/",
    };
  }
  return {
    id: `surface_${slugifyName(pathname).replace(/-/g, "_") || "unknown"}`,
    kind: "unknown",
    summary: `Observed surface ${pathname}`,
    urlShape: pathname,
  };
}

function defaultNode(id: string): NodeAccumulator {
  const summary =
    id === "any_authenticated_state"
      ? "Any authenticated Instagram state"
      : id.replace(/_/g, " ");
  return {
    id,
    surfaceKind: id,
    summary,
    urlShapes: new Set(),
    signals: new Map(),
    evidenceRefs: new Set(),
  };
}

function addControlSignals(
  node: NodeAccumulator | undefined,
  controls: SnapshotControlSummary[] | undefined,
): void {
  if (!node || !controls?.length) return;
  for (const control of controls) {
    const signal = controlSignal(control);
    if (!signal) continue;
    node.signals.set(signal, (node.signals.get(signal) || 0) + 1);
  }
}

function controlSignal(control: SnapshotControlSummary): string | undefined {
  const name = (control.name || "").replace(/\s+/g, " ").trim();
  if (!name) return `${control.role} control`;
  if (/user-profile-picture|new messages|reacted|unread|you:/i.test(name)) {
    return "thread row";
  }
  if (/conversation information/i.test(name)) return "Conversation information";
  if (/new message/i.test(name)) return "New message";
  if (/search/i.test(name) && control.role === "textbox")
    return "Search textbox";
  if (/choose an emoji/i.test(name)) return "Emoji button";
  if (/voice clip/i.test(name)) return "Voice clip";
  if (/add photo or video/i.test(name)) return "Add media";
  if (/gif|sticker/i.test(name)) return "GIF/sticker";
  if (/profile page|view profile/i.test(name)) return "Profile link";
  if (["Home", "Explore", "Reels", "Messages"].includes(name)) return name;
  if (name.length > 60) return undefined;
  return name;
}

function finalizeNode(node: NodeAccumulator): SiteGraphNode {
  return {
    id: node.id,
    surfaceKind: node.surfaceKind,
    summary: node.summary,
    urlShapes: [...node.urlShapes].sort(),
    signals: [...node.signals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([signal]) => signal),
    evidenceCount: node.evidenceRefs.size,
    evidenceRefs: [...node.evidenceRefs].slice(0, 8),
    surfacePacketPath: surfacePacketPath("instagram.com", node.id),
  };
}

function finalizeAction(action: ActionAccumulator): SiteGraphAction {
  const evidenceRefs = [...action.evidenceRefs].slice(0, 8);
  const executableByAgent =
    action.implementation.type === "cli" &&
    action.trust === "trusted_cli" &&
    action.risk !== "destructive";
  const writeConfirmationRequired =
    executableByAgent && ["write", "write_submit"].includes(action.risk);
  const implementation =
    action.implementation.type === "fallback_observed" &&
    action.trust !== "failed"
      ? {
          type: "fallback_observed" as const,
          status: "not_trusted" as const,
          reason: "observed in fallback evidence only",
        }
      : action.implementation;
  return {
    id: action.id,
    from: action.from,
    to: action.to,
    summary: action.summary,
    risk: action.risk,
    trust: action.trust,
    implementation,
    outputs: action.outputs,
    postconditions: action.postconditions,
    evidenceCount: action.evidenceRefs.size,
    evidenceRefs,
    executableByAgent,
    writeConfirmationRequired: writeConfirmationRequired || undefined,
    whyNotExecutable: executableByAgent ? undefined : whyNotExecutable(action),
  };
}

function whyNotExecutable(action: ActionAccumulator): string {
  if (action.implementation.type !== "cli")
    return "no trusted CLI implementation";
  if (action.trust !== "trusted_cli") return `trust is ${action.trust}`;
  if (action.risk === "destructive")
    return "destructive actions require manual review";
  return "not executable";
}

function mergeTrust(
  left: SiteGraphTrust,
  right: SiteGraphTrust,
): SiteGraphTrust {
  const rank: SiteGraphTrust[] = [
    "trusted_cli",
    "observed",
    "weak",
    "rerecord_required",
    "failed",
  ];
  return rank[Math.min(rank.indexOf(left), rank.indexOf(right))] || left;
}

function mergeRisk(left: SiteGraphRisk, right: SiteGraphRisk): SiteGraphRisk {
  const rank: SiteGraphRisk[] = [
    "read",
    "safe_navigation",
    "unknown",
    "write",
    "write_submit",
    "destructive",
  ];
  return rank[Math.max(rank.indexOf(left), rank.indexOf(right))] || left;
}

function evidenceRefForOperation(
  tape: FallbackTape,
  operation: FallbackOperation,
): string {
  return operation.evidenceSummaryPath || operation.evidencePath
    ? `fallback:${tape.id}:op:${operation.id}`
    : `fallback:${tape.id}`;
}

function synthesizeWorkflows(actions: SiteGraphAction[]): SiteGraphWorkflow[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return [
    workflowFromSteps(
      byId,
      "workflow.send_dm_by_thread_name",
      "Open an Instagram DM thread by name and send a message",
      [
        "action.open_inbox",
        "action.open_thread_by_name",
        "action.send_message_current_thread",
      ],
    ),
    workflowFromSteps(
      byId,
      "workflow.read_profile_by_username",
      "Open an Instagram profile and read its visible summary",
      [
        "action.open_profile_by_username",
        "action.read_current_profile_summary",
      ],
    ),
    workflowFromSteps(
      byId,
      "workflow.read_notifications",
      "Open Instagram notifications and read visible notification text",
      [
        "action.open_notifications",
        "action.read_current_notifications_summary",
      ],
    ),
    workflowFromSteps(
      byId,
      "workflow.summarize_notifications_to_dm",
      "Read Instagram notifications, open a DM thread, and send a summary",
      [
        "action.open_notifications",
        "action.read_current_notifications_summary",
        "action.open_inbox",
        "action.open_thread_by_name",
        "action.send_message_current_thread",
      ],
    ),
  ].filter((workflow): workflow is SiteGraphWorkflow => Boolean(workflow));
}

function workflowFromSteps(
  byId: Map<string, SiteGraphAction>,
  id: string,
  summary: string,
  requestedSteps: string[],
): SiteGraphWorkflow | undefined {
  const steps = requestedSteps.filter((step) => byId.has(step));
  if (!steps.length) return undefined;
  const blockingActions = steps.filter((step) => {
    const action = byId.get(step);
    return action ? !action.executableByAgent : true;
  });
  return {
    id,
    summary,
    steps,
    automationReadiness:
      steps.length === requestedSteps.length && !blockingActions.length
        ? "ready"
        : blockingActions.length
          ? "partial"
          : "partial",
    blockingActions,
  };
}

function commandTitle(name: string): string {
  return name.replace(/_/g, " ");
}

function commandSlug(name: string): string {
  return name.replace(/_/g, "-");
}
