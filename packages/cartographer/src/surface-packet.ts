import type {
  Domain,
  FallbackTape,
  PlaywrightCliEvidenceSummary,
  Postcondition,
  ProcessOutput,
  SnapshotControlSummary,
} from "./contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import {
  browserSessionPath,
  slugifyName,
  surfacePacketDir,
  surfacePacketIndexPath,
  surfacePacketPath,
} from "./paths.js";
import type {
  SiteGraph,
  SiteGraphAction,
  SiteGraphNode,
} from "./site-graph.js";

export interface SurfacePacketIndex {
  schemaVersion: 1;
  domain: Domain;
  generatedAt: string;
  packetCount: number;
  packets: Array<{
    nodeId: string;
    path: string;
    summary: string;
    actionCount: number;
    decisionRequired: boolean;
  }>;
}

export interface SurfacePacket {
  schemaVersion: 1;
  domain: Domain;
  nodeId: string;
  generatedAt: string;
  source: "site_graph" | "live_browser";
  summary: string;
  urlShapes: string[];
  signals: string[];
  agentDecisionRequired: boolean;
  decisionReason?: string;
  controls: SurfaceControl[];
  collections: Record<string, SurfaceCollectionItem[]>;
  outgoingActions: SurfaceActionSummary[];
  evidenceRefs: string[];
  warnings: string[];
}

export interface SurfaceControl {
  ref?: string;
  role: string;
  name?: string;
  href?: string;
  suggestedAction?: string;
  stableSelector?: string;
}

export interface SurfaceCollectionItem {
  label: string;
  kind: "thread" | "group_thread" | "account" | "button" | "link" | "unknown";
  username?: string;
  subtitle?: string;
  ref?: string;
  action?: string;
}

export interface SurfaceActionSummary {
  id: string;
  to: string;
  summary: string;
  risk: string;
  trust: string;
  executableByAgent: boolean;
  command?: string;
  args?: string[];
  outputs?: ProcessOutput[];
  postconditions?: Postcondition[];
  writeConfirmationRequired?: boolean;
  whyNotExecutable?: string;
}

export async function emitSurfacePackets(input: {
  domain: Domain;
  graph: SiteGraph;
  tapes: FallbackTape[];
}): Promise<SurfacePacketIndex> {
  await ensureDir(surfacePacketDir(input.domain));
  const packets = input.graph.nodes.map((node) =>
    buildSurfacePacket({
      domain: input.domain,
      graph: input.graph,
      node,
      summaries: summariesForNode(input.tapes, node.id),
    }),
  );
  for (const packet of packets) {
    await writeJsonFile(surfacePacketPath(input.domain, packet.nodeId), packet);
  }
  const index: SurfacePacketIndex = {
    schemaVersion: 1,
    domain: input.domain,
    generatedAt: new Date().toISOString(),
    packetCount: packets.length,
    packets: packets.map((packet) => ({
      nodeId: packet.nodeId,
      path: surfacePacketPath(input.domain, packet.nodeId),
      summary: packet.summary,
      actionCount: packet.outgoingActions.length,
      decisionRequired: packet.agentDecisionRequired,
    })),
  };
  await writeJsonFile(surfacePacketIndexPath(input.domain), index);
  return index;
}

export async function loadSurfacePacket(input: {
  domain: Domain;
  nodeId: string;
}): Promise<SurfacePacket | null> {
  return await readJsonFile<SurfacePacket>(
    surfacePacketPath(input.domain, input.nodeId),
  );
}

export async function loadSurfacePacketIndex(
  domain: Domain,
): Promise<SurfacePacketIndex | null> {
  return await readJsonFile<SurfacePacketIndex>(surfacePacketIndexPath(domain));
}

export async function currentLiveSurfacePacket(
  domain: Domain,
): Promise<SurfacePacket | null> {
  const record = await readJsonFile<{ cdpUrl?: string }>(
    browserSessionPath(domain),
  );
  if (!record?.cdpUrl || !(await cdpAlive(record.cdpUrl))) return null;
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP(record.cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!page) return null;
    const url = page.url();
    const title = await page.title().catch((): undefined => undefined);
    const controls = await page
      .locator(
        "a,button,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[contenteditable='true']",
      )
      .evaluateAll((elements) =>
        elements.slice(0, 80).map((element, index) => {
          const el = element as HTMLElement;
          const role =
            el.getAttribute("role") ||
            (el.tagName.toLowerCase() === "a"
              ? "link"
              : el.tagName.toLowerCase() === "button"
                ? "button"
                : el instanceof HTMLInputElement ||
                    el instanceof HTMLTextAreaElement ||
                    el.isContentEditable
                  ? "textbox"
                  : el.tagName.toLowerCase());
          const name =
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.textContent?.replace(/\s+/g, " ").trim().slice(0, 140) ||
            undefined;
          const href =
            el instanceof HTMLAnchorElement
              ? el.getAttribute("href") || undefined
              : undefined;
          return { ref: `live${index + 1}`, role, name, href };
        }),
      )
      .catch((): SurfaceControl[] => []);
    const node = surfaceIdFromUrlAndControls(url, controls);
    return {
      schemaVersion: 1,
      domain,
      nodeId: node.id,
      generatedAt: new Date().toISOString(),
      source: "live_browser",
      summary: title || node.summary,
      urlShapes: [node.urlShape || url].filter(Boolean),
      signals: controls
        .slice(0, 20)
        .map((control) => control.name || control.role),
      agentDecisionRequired: decisionRequired(node.id),
      decisionReason: decisionReason(node.id),
      controls: controls.map(enrichControl),
      collections: collectionsFromControls(controls),
      outgoingActions: [],
      evidenceRefs: [],
      warnings: [
        "live refs are ephemeral; use them only inside recorded fallback",
      ],
    };
  } finally {
    (browser as { disconnect?: () => void }).disconnect?.();
  }
}

function buildSurfacePacket(input: {
  domain: Domain;
  graph: SiteGraph;
  node: SiteGraphNode;
  summaries: PlaywrightCliEvidenceSummary[];
}): SurfacePacket {
  const controls = dedupeControls(
    input.summaries.flatMap((summary) => summary.controls || []),
  ).map(enrichControl);
  const outgoing = input.graph.actions
    .filter((action) => action.from === input.node.id)
    .map(actionSummary);
  return {
    schemaVersion: 1,
    domain: input.domain,
    nodeId: input.node.id,
    generatedAt: input.graph.generatedAt,
    source: "site_graph",
    summary: input.node.summary,
    urlShapes: input.node.urlShapes,
    signals: input.node.signals,
    agentDecisionRequired: decisionRequired(input.node.id),
    decisionReason: decisionReason(input.node.id),
    controls,
    collections: collectionsFromControls(controls),
    outgoingActions: outgoing,
    evidenceRefs: input.node.evidenceRefs,
    warnings: controls.some((control) => control.ref?.startsWith("e"))
      ? ["snapshot refs are evidence refs, not durable command selectors"]
      : [],
  };
}

function summariesForNode(
  tapes: FallbackTape[],
  nodeId: string,
): PlaywrightCliEvidenceSummary[] {
  const summaries: PlaywrightCliEvidenceSummary[] = [];
  for (const tape of tapes) {
    for (const operation of tape.operations || []) {
      const summary = operation.evidenceSummary;
      if (!summary) continue;
      const after = surfaceIdFromUrlAndControls(
        operation.urlAfter || summary.urlAfter || operation.urlBefore,
        summary.controls,
      ).id;
      const before = surfaceIdFromUrlAndControls(
        operation.urlBefore || summary.urlBefore || operation.urlAfter,
        summary.controls,
      ).id;
      if (after === nodeId || before === nodeId) summaries.push(summary);
    }
  }
  return summaries;
}

function actionSummary(action: SiteGraphAction): SurfaceActionSummary {
  return {
    id: action.id,
    to: action.to,
    summary: action.summary,
    risk: action.risk,
    trust: action.trust,
    executableByAgent: action.executableByAgent,
    command:
      action.implementation.type === "cli"
        ? action.implementation.command
        : undefined,
    args:
      action.implementation.type === "cli"
        ? action.implementation.args
        : undefined,
    outputs: action.outputs,
    postconditions: action.postconditions,
    writeConfirmationRequired: action.writeConfirmationRequired,
    whyNotExecutable: action.whyNotExecutable,
  };
}

function enrichControl(control: SnapshotControlSummary): SurfaceControl {
  const suggestedAction = suggestedActionForControl(control);
  return {
    ref: control.ref,
    role: control.role,
    name: control.name,
    href: control.href,
    suggestedAction,
    stableSelector: stableSelectorForControl(control),
  };
}

function stableSelectorForControl(
  control: Pick<SurfaceControl, "role" | "name" | "href">,
): string | undefined {
  if (control.role && control.name && control.name.length < 80) {
    return `role=${control.role}[name=${JSON.stringify(control.name)}]`;
  }
  if (control.href?.startsWith("/")) return `a[href='${control.href}']`;
  return undefined;
}

function suggestedActionForControl(
  control: Pick<SurfaceControl, "role" | "name" | "href">,
): string | undefined {
  const source =
    `${control.role} ${control.name || ""} ${control.href || ""}`.toLowerCase();
  if (source.includes("search")) return "search";
  if (source.includes("new message")) return "compose_new_message";
  if (source.includes("conversation information"))
    return "open_conversation_information";
  if (source.includes("send")) return "submit_write";
  if (control.href?.startsWith("/direct/t/")) return "open_thread";
  if (control.href?.match(/^\/[A-Za-z0-9._]+\/?$/)) return "open_profile";
  return undefined;
}

function collectionsFromControls(
  controls: Array<Pick<SurfaceControl, "ref" | "role" | "name" | "href">>,
): Record<string, SurfaceCollectionItem[]> {
  const results: SurfaceCollectionItem[] = [];
  for (const control of controls) {
    if (control.role !== "button" && control.role !== "link") continue;
    const name = cleanName(control.name);
    if (!name) continue;
    if (
      /user avatar|user-profile-picture|matched messages|new messages|you:/i.test(
        name,
      )
    ) {
      results.push({
        label: labelFromName(name),
        username: usernameFromName(name),
        subtitle: subtitleFromName(name),
        kind: kindFromName(name, control.href),
        ref: control.ref,
        action: suggestedActionForControl(control),
      });
    }
  }
  return results.length ? { results: results.slice(0, 30) } : {};
}

function dedupeControls(
  controls: SnapshotControlSummary[],
): SnapshotControlSummary[] {
  const byKey = new Map<string, SnapshotControlSummary>();
  for (const control of controls) {
    const key = `${control.role}:${control.name || ""}:${control.href || ""}`;
    if (!byKey.has(key)) byKey.set(key, control);
  }
  return [...byKey.values()].slice(0, 80);
}

export function surfaceIdFromUrlAndControls(
  url: string | undefined,
  controls: Array<Pick<SurfaceControl, "role" | "name" | "href">> = [],
): { id: string; summary: string; urlShape?: string } {
  const pathname = pathnameFor(url);
  const source = controls
    .map((control) => `${control.role} ${control.name || ""}`)
    .join(" ");
  if (
    pathname.includes("/direct/inbox") &&
    /clear search|matched messages|more accounts/i.test(source)
  ) {
    return {
      id: /more accounts/i.test(source)
        ? "account_search_results"
        : "direct_search_results",
      summary: "Instagram direct search results",
      urlShape: "/direct/inbox/",
    };
  }
  if (pathname.includes("/direct/inbox")) {
    return {
      id: "direct_inbox",
      summary: "Instagram direct inbox",
      urlShape: "/direct/inbox/",
    };
  }
  if (pathname.includes("/direct/t/")) {
    if (/send\b|message\.\.\.|choose an emoji|voice clip/i.test(source)) {
      return {
        id: "composer_ready",
        summary: "Instagram direct-message thread with composer",
        urlShape: "/direct/t/:threadId/",
      };
    }
    return {
      id: "direct_thread",
      summary: "Instagram direct-message thread",
      urlShape: "/direct/t/:threadId/",
    };
  }
  if (pathname.includes("/explore")) {
    return {
      id: "explore",
      summary: "Instagram Explore",
      urlShape: "/explore/",
    };
  }
  if (pathname === "/" || pathname === "") {
    return { id: "home", summary: "Instagram home", urlShape: "/" };
  }
  if (
    /^\/[A-Za-z0-9._]+\/?$/.test(pathname) &&
    !/^\/(?:accounts|direct|explore|p|reel|stories)\b/.test(pathname)
  ) {
    return {
      id: "profile",
      summary: "Instagram profile",
      urlShape: "/:username/",
    };
  }
  return {
    id: `surface_${slugifyName(pathname).replace(/-/g, "_") || "unknown"}`,
    summary: `Observed surface ${pathname || "unknown"}`,
    urlShape: pathname,
  };
}

function decisionRequired(nodeId: string): boolean {
  return [
    "direct_search_results",
    "account_search_results",
    "conversation_information",
  ].includes(nodeId);
}

function decisionReason(nodeId: string): string | undefined {
  if (
    nodeId === "direct_search_results" ||
    nodeId === "account_search_results"
  ) {
    return "Search result surfaces may contain duplicate people, accounts, groups, and message matches.";
  }
  if (nodeId === "conversation_information") {
    return "Conversation information exposes several controls whose effects need agent judgment.";
  }
  return undefined;
}

function pathnameFor(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function cleanName(name: string | undefined): string {
  return (name || "").replace(/\s+/g, " ").trim();
}

function labelFromName(name: string): string {
  return name
    .replace(/^User avatar\s+/i, "")
    .replace(/^user-profile-picture\s+/i, "")
    .split(
      /\b(?:You:|You sent|sent|matched messages|new messages|\d+\s+(?:matched|new))/i,
    )[0]
    .trim()
    .slice(0, 120);
}

function usernameFromName(name: string): string | undefined {
  const candidates = name.match(/\b[a-z0-9._]{3,}\b/gi) || [];
  return candidates.find((candidate) => /[._]/.test(candidate));
}

function subtitleFromName(name: string): string | undefined {
  const cleaned = cleanName(name);
  const label = labelFromName(cleaned);
  const subtitle = cleaned.slice(label.length).trim();
  return subtitle || undefined;
}

function kindFromName(
  name: string,
  href?: string,
): SurfaceCollectionItem["kind"] {
  if (/user-profile-picture user-profile-picture|group\b/i.test(name))
    return "group_thread";
  if (/matched messages|you:|new messages|sent an attachment/i.test(name))
    return "thread";
  if (href?.match(/^\/[A-Za-z0-9._]+\/?$/)) return "account";
  if (/user avatar/i.test(name)) return "account";
  return "button";
}

async function cdpAlive(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}
