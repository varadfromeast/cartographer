import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Domain } from "../contracts.js";
import { readJsonFile, writeJsonFile } from "../fs-json.js";
import { sha256 } from "../hash.js";
import { siteDir, slugifyName } from "../paths.js";
import type { CapturedControl, SurfaceCapture } from "./surface-capture.js";

export type SurfaceType =
  | "instagram_home_feed"
  | "instagram_search"
  | "instagram_notifications"
  | "instagram_dm_inbox"
  | "instagram_dm_composer"
  | "instagram_profile"
  | "linkedin_home_feed"
  | "linkedin_search_results"
  | "linkedin_messaging"
  | "linkedin_notifications"
  | "linkedin_my_network"
  | "linkedin_jobs"
  | "linkedin_learning"
  | "linkedin_profile"
  | "linkedin_profile_analytics"
  | "linkedin_preferences"
  | "x_home"
  | "x_explore"
  | "x_notifications"
  | "x_messages"
  | "x_bookmarks"
  | "x_grok"
  | "x_profile"
  | "yc_home"
  | "yc_about"
  | "yc_companies"
  | "yc_company_profile"
  | "yc_jobs"
  | "yc_job_profile"
  | "yc_careers"
  | "yc_apply"
  | "yc_blog"
  | "yc_content_page"
  | "yc_library"
  | "yc_library_search"
  | "yc_launches"
  | "yc_deals"
  | "yc_partners"
  | "yc_people"
  | "yc_cofounder_matching"
  | "yc_investors"
  | "yc_demo_day"
  | "yc_documents"
  | "yc_faq"
  | "yc_contact"
  | "yc_press"
  | "yc_legal"
  | "yc_software"
  | "yc_early_decision"
  | "yc_security"
  | "yc_handshake"
  | "login"
  | "unknown";

export interface SurfaceClassification {
  schemaVersion: 1;
  method: "classifySurface";
  stable: boolean;
  surfaceType: SurfaceType;
  confidence: number;
  nodeId: string;
  title?: string;
  url: string;
  urlShape: string;
  signals: string[];
  blockers: string[];
  artifactPath: string;
}

export interface CandidateEdge {
  edgeId: string;
  label: string;
  fromNodeId: string;
  actionKind: CapturedControl["actionKind"];
  controlRef: string;
  controlStableId: string;
  controlName?: string;
  href?: string;
  toHint: string;
  priority: number;
  writeRisk: "none" | "possible" | "destructive";
  warnings: string[];
  selectorCandidates: CapturedControl["selectorCandidates"];
  evidence: {
    rect: CapturedControl["rect"];
    context: CapturedControl["context"];
  };
}

export interface CandidateEdgesArtifact {
  schemaVersion: 1;
  method: "extractCandidateEdges";
  stable: boolean;
  fromNodeId: string;
  edgeCount: number;
  edges: CandidateEdge[];
  blockers: string[];
  artifactPath: string;
}

export interface GraphMutationArtifact {
  schemaVersion: 1;
  method: "recordGraphMutation";
  stable: boolean;
  graphPath: string;
  node: {
    nodeId: string;
    surfaceType: SurfaceType;
    url: string;
    urlShape: string;
    title?: string;
    captureId: string;
    surfaceHash: string;
    evidence: {
      surfaceJsonPath: string;
      markdownPath: string;
      screenshotPath: string;
      screenshotOverlayPath?: string;
      ariaSnapshotPath?: string;
    };
  };
  edgeCount: number;
  blockers: string[];
  artifactPath: string;
}

export interface GraphCandidate {
  schemaVersion: 1;
  domain: Domain;
  updatedAt: string;
  nodes: GraphMutationArtifact["node"][];
  edges: CandidateEdge[];
}

export interface NodeMatchArtifact {
  schemaVersion: 1;
  method: "matchExistingNode";
  stable: boolean;
  proposedNodeId: string;
  matched: boolean;
  matchedNodeId?: string;
  matchedCaptureId?: string;
  matchedSurfaceJsonPath?: string;
  confidence: number;
  reasons: string[];
  blockers: string[];
  artifactPath: string;
}

export interface ControlDiffArtifact {
  schemaVersion: 1;
  method: "diffSurfaceControls";
  stable: boolean;
  fromCaptureId?: string;
  toCaptureId: string;
  matchedNodeId?: string;
  summary: {
    stable: number;
    driftedSelector: number;
    renamed: number;
    missing: number;
    newCandidate: number;
  };
  changes: ControlDiffChange[];
  blockers: string[];
  artifactPath: string;
}

export interface ControlDiffChange {
  status:
    | "stable"
    | "drifted_selector"
    | "renamed"
    | "missing"
    | "new_candidate";
  previousRef?: string;
  currentRef?: string;
  previousStableId?: string;
  currentStableId?: string;
  role?: string;
  previousLabel?: string;
  currentLabel?: string;
  href?: string;
  reason: string;
}

export interface EdgeReconciliationArtifact {
  schemaVersion: 1;
  method: "reconcileEdges";
  stable: boolean;
  fromNodeId: string;
  previousEdgeCount: number;
  currentEdgeCount: number;
  summary: {
    stable: number;
    driftedSelector: number;
    renamed: number;
    missing: number;
    newCandidate: number;
  };
  edges: EdgeReconciliationChange[];
  blockers: string[];
  artifactPath: string;
}

export interface EdgeReconciliationChange {
  status:
    | "stable"
    | "drifted_selector"
    | "renamed"
    | "missing"
    | "new_candidate";
  previousEdgeId?: string;
  currentEdgeId?: string;
  previousLabel?: string;
  currentLabel?: string;
  href?: string;
  actionKind?: CapturedControl["actionKind"];
  reason: string;
}

export interface PostCaptureArtifacts {
  classification: SurfaceClassification;
  nodeMatch?: NodeMatchArtifact;
  controlDiff?: ControlDiffArtifact;
  candidateEdges?: CandidateEdgesArtifact;
  edgeReconciliation?: EdgeReconciliationArtifact;
  graphMutation?: GraphMutationArtifact;
}

export async function runPostCaptureMethods(input: {
  domain: Domain;
  runDir: string;
  capture: SurfaceCapture;
}): Promise<PostCaptureArtifacts> {
  const classification = await classifySurface(input.capture);
  const classificationPath = path.join(
    input.capture.artifactDir,
    "classification.json",
  );
  classification.artifactPath = classificationPath;
  await writeJsonFile(classificationPath, classification);

  let nodeMatch: NodeMatchArtifact | undefined;
  let controlDiff: ControlDiffArtifact | undefined;
  if (classification.stable) {
    nodeMatch = await matchExistingNode({
      domain: input.domain,
      runDir: input.runDir,
      capture: input.capture,
      classification,
    });
    const matchPath = path.join(input.capture.artifactDir, "node-match.json");
    nodeMatch.artifactPath = matchPath;
    await writeJsonFile(matchPath, nodeMatch);

    controlDiff = await diffSurfaceControls({
      capture: input.capture,
      nodeMatch,
    });
    const diffPath = path.join(input.capture.artifactDir, "control-diff.json");
    controlDiff.artifactPath = diffPath;
    await writeJsonFile(diffPath, controlDiff);
  }

  let candidateEdges: CandidateEdgesArtifact | undefined;
  if (classification.stable) {
    candidateEdges = await extractCandidateEdges(input.capture, classification);
    const edgesPath = path.join(
      input.capture.artifactDir,
      "candidate-edges.json",
    );
    candidateEdges.artifactPath = edgesPath;
    await writeJsonFile(edgesPath, candidateEdges);
  }

  let edgeReconciliation: EdgeReconciliationArtifact | undefined;
  if (classification.stable && candidateEdges) {
    edgeReconciliation = await reconcileEdges({
      domain: input.domain,
      runDir: input.runDir,
      classification,
      candidateEdges,
      nodeMatch,
    });
    const reconciliationPath = path.join(
      input.capture.artifactDir,
      "edge-reconciliation.json",
    );
    edgeReconciliation.artifactPath = reconciliationPath;
    await writeJsonFile(reconciliationPath, edgeReconciliation);
  }

  let graphMutation: GraphMutationArtifact | undefined;
  if (classification.stable && candidateEdges?.stable) {
    graphMutation = await recordGraphMutation({
      domain: input.domain,
      runDir: input.runDir,
      capture: input.capture,
      classification,
      candidateEdges,
    });
    const mutationPath = path.join(
      input.capture.artifactDir,
      "graph-mutation.json",
    );
    graphMutation.artifactPath = mutationPath;
    await writeJsonFile(mutationPath, graphMutation);
  }

  return {
    classification,
    nodeMatch,
    controlDiff,
    candidateEdges,
    edgeReconciliation,
    graphMutation,
  };
}

async function classifySurface(
  capture: SurfaceCapture,
): Promise<SurfaceClassification> {
  const text =
    `${capture.title || ""}\n${capture.url}\n${capture.markdown.preview}\n${capture.controls
      .slice(0, 80)
      .map((control) => control.name || control.text || control.href || "")
      .join("\n")}`.toLowerCase();
  const signals: string[] = [];
  const blockers: string[] = [];
  let surfaceType: SurfaceType = "unknown";
  let confidence = 0.2;

  const url = new URL(capture.url);
  if (isLoginSurface(capture, url, text)) {
    surfaceType = "login";
    confidence = 0.9;
    signals.push("login text/password signal");
    blockers.push("login required");
  } else if (capture.domain === "instagram.com" && isInstagramHome(url)) {
    surfaceType = "instagram_home_feed";
    confidence = 0.84;
    signals.push("Instagram home URL");
  } else if (
    capture.domain === "instagram.com" &&
    url.pathname.startsWith("/explore/search")
  ) {
    surfaceType = "instagram_search";
    confidence = 0.86;
    signals.push("Instagram search URL");
  } else if (
    capture.domain === "instagram.com" &&
    url.pathname.startsWith("/notifications")
  ) {
    surfaceType = "instagram_notifications";
    confidence = 0.86;
    signals.push("Instagram notifications URL");
  } else if (
    capture.domain === "instagram.com" &&
    url.pathname.startsWith("/direct/inbox")
  ) {
    surfaceType = "instagram_dm_inbox";
    confidence = 0.88;
    signals.push("Instagram direct inbox URL");
  } else if (
    capture.domain === "instagram.com" &&
    url.pathname.startsWith("/direct/t/")
  ) {
    surfaceType = "instagram_dm_composer";
    confidence = 0.88;
    signals.push("Instagram direct thread URL");
  } else if (
    capture.domain === "instagram.com" &&
    instagramProfileUsername(url.pathname)
  ) {
    surfaceType = "instagram_profile";
    confidence = 0.78;
    signals.push("Instagram profile-shaped URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/feed")
  ) {
    surfaceType = "linkedin_home_feed";
    confidence = 0.88;
    signals.push("LinkedIn feed URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/search/results")
  ) {
    surfaceType = "linkedin_search_results";
    confidence = 0.86;
    signals.push("LinkedIn search results URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/messaging")
  ) {
    surfaceType = "linkedin_messaging";
    confidence = 0.86;
    signals.push("LinkedIn messaging URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/notifications")
  ) {
    surfaceType = "linkedin_notifications";
    confidence = 0.86;
    signals.push("LinkedIn notifications URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/mynetwork")
  ) {
    surfaceType = "linkedin_my_network";
    confidence = 0.86;
    signals.push("LinkedIn my network URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/jobs")
  ) {
    surfaceType = "linkedin_jobs";
    confidence = 0.84;
    signals.push("LinkedIn jobs URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/learning")
  ) {
    surfaceType = "linkedin_learning";
    confidence = 0.84;
    signals.push("LinkedIn learning URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/in/")
  ) {
    surfaceType = "linkedin_profile";
    confidence = 0.84;
    signals.push("LinkedIn profile URL");
  } else if (
    capture.domain === "linkedin.com" &&
    (url.pathname.startsWith("/analytics/profile-views") ||
      url.pathname.startsWith("/me/profile-views"))
  ) {
    surfaceType = "linkedin_profile_analytics";
    confidence = 0.82;
    signals.push("LinkedIn profile analytics URL");
  } else if (
    capture.domain === "linkedin.com" &&
    url.pathname.startsWith("/mypreferences")
  ) {
    surfaceType = "linkedin_preferences";
    confidence = 0.82;
    signals.push("LinkedIn preferences URL");
  } else if (capture.domain === "x.com" && url.pathname === "/home") {
    surfaceType = "x_home";
    confidence = 0.84;
    signals.push("X home URL");
  } else if (
    capture.domain === "x.com" &&
    url.pathname.startsWith("/explore")
  ) {
    surfaceType = "x_explore";
    confidence = 0.84;
    signals.push("X explore URL");
  } else if (
    capture.domain === "x.com" &&
    url.pathname.startsWith("/notifications")
  ) {
    surfaceType = "x_notifications";
    confidence = 0.84;
    signals.push("X notifications URL");
  } else if (
    capture.domain === "x.com" &&
    (url.pathname.startsWith("/messages") || url.pathname.startsWith("/i/chat"))
  ) {
    surfaceType = "x_messages";
    confidence = 0.84;
    signals.push("X messages URL");
  } else if (
    capture.domain === "x.com" &&
    url.pathname.startsWith("/i/bookmarks")
  ) {
    surfaceType = "x_bookmarks";
    confidence = 0.84;
    signals.push("X bookmarks URL");
  } else if (capture.domain === "x.com" && url.pathname.startsWith("/i/grok")) {
    surfaceType = "x_grok";
    confidence = 0.84;
    signals.push("X Grok URL");
  } else if (capture.domain === "x.com" && xProfileUsername(url.pathname)) {
    surfaceType = "x_profile";
    confidence = 0.76;
    signals.push("X profile-shaped URL");
  } else if (capture.domain === "ycombinator.com" && isYcHome(url)) {
    surfaceType = "yc_home";
    confidence = 0.86;
    signals.push("YC home URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/about")
  ) {
    surfaceType = "yc_about";
    confidence = 0.84;
    signals.push("YC about URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/companies/")
  ) {
    surfaceType = "yc_company_profile";
    confidence = 0.84;
    signals.push("YC company profile URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/companies")
  ) {
    surfaceType = "yc_companies";
    confidence = 0.84;
    signals.push("YC companies URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/jobs/")
  ) {
    surfaceType = "yc_job_profile";
    confidence = 0.82;
    signals.push("YC job detail URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/jobs")
  ) {
    surfaceType = "yc_jobs";
    confidence = 0.84;
    signals.push("YC jobs URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/careers")
  ) {
    surfaceType = "yc_careers";
    confidence = 0.82;
    signals.push("YC careers URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/apply")
  ) {
    surfaceType = "yc_apply";
    confidence = 0.84;
    signals.push("YC apply URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/blog")
  ) {
    surfaceType = "yc_blog";
    confidence = 0.84;
    signals.push("YC blog URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/library/search")
  ) {
    surfaceType = "yc_library_search";
    confidence = 0.82;
    signals.push("YC library search URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/library")
  ) {
    surfaceType = "yc_library";
    confidence = 0.82;
    signals.push("YC library URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/launches")
  ) {
    surfaceType = "yc_launches";
    confidence = 0.82;
    signals.push("YC launches URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    (url.pathname.startsWith("/deals") || url.pathname.startsWith("/deal"))
  ) {
    surfaceType = "yc_deals";
    confidence = 0.82;
    signals.push("YC deals URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/partners")
  ) {
    surfaceType = "yc_partners";
    confidence = 0.82;
    signals.push("YC partners URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/people")
  ) {
    surfaceType = "yc_people";
    confidence = 0.82;
    signals.push("YC people URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/cofounder-matching")
  ) {
    surfaceType = "yc_cofounder_matching";
    confidence = 0.82;
    signals.push("YC co-founder matching URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/investors")
  ) {
    surfaceType = "yc_investors";
    confidence = 0.82;
    signals.push("YC investors URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/demoday")
  ) {
    surfaceType = "yc_demo_day";
    confidence = 0.82;
    signals.push("YC demo day URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/documents")
  ) {
    surfaceType = "yc_documents";
    confidence = 0.82;
    signals.push("YC documents URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/faq")
  ) {
    surfaceType = "yc_faq";
    confidence = 0.82;
    signals.push("YC FAQ URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/contact")
  ) {
    surfaceType = "yc_contact";
    confidence = 0.82;
    signals.push("YC contact URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/press")
  ) {
    surfaceType = "yc_press";
    confidence = 0.82;
    signals.push("YC press URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/legal")
  ) {
    surfaceType = "yc_legal";
    confidence = 0.82;
    signals.push("YC legal URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/software")
  ) {
    surfaceType = "yc_software";
    confidence = 0.82;
    signals.push("YC software URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/early-decision")
  ) {
    surfaceType = "yc_early_decision";
    confidence = 0.82;
    signals.push("YC early decision URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/security")
  ) {
    surfaceType = "yc_security";
    confidence = 0.82;
    signals.push("YC security URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    url.pathname.startsWith("/handshake")
  ) {
    surfaceType = "yc_handshake";
    confidence = 0.82;
    signals.push("YC handshake URL");
  } else if (
    capture.domain === "ycombinator.com" &&
    isYcRootContentPage(url, capture.title || "", capture.markdown.preview)
  ) {
    surfaceType = "yc_content_page";
    confidence = 0.8;
    signals.push("YC root content page");
  }

  if (capture.controls.length >= 5) signals.push("visible controls captured");
  if (capture.ariaSnapshot) signals.push("ARIA snapshot captured");
  if (capture.screenshot.overlayPath) signals.push("control overlay captured");

  if (surfaceType === "unknown") blockers.push("no known surface rule matched");
  if (capture.controls.length < 3)
    blockers.push("too few controls for stable surface");

  const stable =
    confidence >= 0.75 &&
    surfaceType !== "unknown" &&
    surfaceType !== "login" &&
    capture.controls.length >= 3;

  return {
    schemaVersion: 1,
    method: "classifySurface",
    stable,
    surfaceType,
    confidence,
    nodeId: nodeIdFor(capture.domain, surfaceType, capture.urlShape),
    title: capture.title,
    url: capture.url,
    urlShape: capture.urlShape,
    signals,
    blockers,
    artifactPath: "",
  };
}

async function extractCandidateEdges(
  capture: SurfaceCapture,
  classification: SurfaceClassification,
): Promise<CandidateEdgesArtifact> {
  const blockers: string[] = [];
  const edges = capture.controls
    .filter((control) => isCandidateEdgeControl(control))
    .map((control) => edgeForControl(control, classification))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 40);

  if (!edges.length) blockers.push("no safe candidate edges extracted");
  const stable = edges.length > 0;
  return {
    schemaVersion: 1,
    method: "extractCandidateEdges",
    stable,
    fromNodeId: classification.nodeId,
    edgeCount: edges.length,
    edges,
    blockers,
    artifactPath: "",
  };
}

function isCandidateEdgeControl(control: CapturedControl): boolean {
  if (control.disabled) return false;
  if (!control.viewport.inViewport && !control.href) return false;
  return Boolean(control.name || control.text || control.href);
}

function edgeForControl(
  control: CapturedControl,
  classification: SurfaceClassification,
): CandidateEdge {
  const label = control.name || control.text || control.href || control.ref;
  const writeRisk = writeRiskFor(control);
  return {
    edgeId: `e_${sha256({
      from: classification.nodeId,
      control: control.stableId,
      href: control.href,
      label,
    }).slice(0, 12)}`,
    label,
    fromNodeId: classification.nodeId,
    actionKind: control.actionKind,
    controlRef: control.ref,
    controlStableId: control.stableId,
    controlName: control.name,
    href: control.href,
    toHint: toHintFor(control),
    priority: priorityFor(control, classification),
    writeRisk,
    warnings: warningsFor(control, writeRisk),
    selectorCandidates: control.selectorCandidates,
    evidence: {
      rect: control.rect,
      context: control.context,
    },
  };
}

function writeRiskFor(control: CapturedControl): CandidateEdge["writeRisk"] {
  if (control.riskHints.includes("destructive")) return "destructive";
  if (control.riskHints.includes("write")) return "possible";
  if (control.riskHints.includes("input")) return "possible";
  if (control.actionKind === "input" || control.actionKind === "select")
    return "possible";
  if (isProtocolNavigation(control)) return "possible";
  if (isAuthNavigation(control)) return "possible";
  return "none";
}

function warningsFor(
  control: CapturedControl,
  writeRisk: CandidateEdge["writeRisk"],
): string[] {
  const warnings: string[] = [];
  if (writeRisk === "possible") {
    warnings.push("may write or prepare user-generated content");
  }
  if (writeRisk === "destructive") {
    warnings.push("may perform destructive or irreversible action");
  }
  if (control.riskHints.includes("input")) {
    warnings.push("requires user/content input");
  }
  if (isAuthNavigation(control)) {
    warnings.push("may enter authentication flow");
  }
  if (isProtocolNavigation(control)) {
    warnings.push("may leave browser navigation context");
  }
  return warnings;
}

function priorityFor(
  control: CapturedControl,
  classification: SurfaceClassification,
): number {
  const label = `${control.name || ""} ${control.href || ""}`.toLowerCase();
  let score = control.viewport.aboveFold ? 20 : 0;
  if (control.actionKind === "navigate") score += 15;
  if (
    /\b(home|network|jobs|messaging|notifications|search|profile)\b/.test(label)
  )
    score += 30;
  if (classification.url.includes("ycombinator.com")) {
    score += ycNavigationPriority(control);
  }
  if (control.context.landmark?.includes("nav")) score += 10;
  if (control.collapsedFrom) score += Math.min(10, control.collapsedFrom);
  return score;
}

function isAuthNavigation(control: CapturedControl): boolean {
  const label = `${control.name || ""} ${control.text || ""} ${control.href || ""}`;
  return (
    /\b(log in|login|sign in|signin)\b/i.test(label) ||
    /\/\/(?:account|apply)\.ycombinator\.com\b/i.test(label)
  );
}

function isProtocolNavigation(control: CapturedControl): boolean {
  return /^(mailto|tel):/i.test(control.href || "");
}

function ycNavigationPriority(control: CapturedControl): number {
  const href = control.href || "";
  const label = `${control.name || ""} ${control.text || ""}`.toLowerCase();
  if (isAuthNavigation(control)) return -120;
  if (
    /\b(apply|about|companies|startup jobs|jobs|library|partners|blog)\b/.test(
      label,
    )
  )
    return 60;
  try {
    const url = new URL(href, "https://www.ycombinator.com");
    if (
      url.hostname === "www.ycombinator.com" &&
      /^\/(about|companies|jobs|apply|blog|library|partners|launches|deals)\/?$/.test(
        url.pathname,
      )
    ) {
      return 80;
    }
    if (
      /^\/(people|companies\/[^/]+|jobs\/role|library\/[^/]+)/.test(
        url.pathname,
      )
    ) {
      return -20;
    }
  } catch {
    return 0;
  }
  return 0;
}

function toHintFor(control: CapturedControl): string {
  if (control.href) {
    try {
      const url = new URL(control.href, "https://www.linkedin.com");
      return url.pathname || "/";
    } catch {
      return control.href;
    }
  }
  return slugifyName(control.name || control.text || control.ref);
}

async function matchExistingNode(input: {
  domain: Domain;
  runDir: string;
  capture: SurfaceCapture;
  classification: SurfaceClassification;
}): Promise<NodeMatchArtifact> {
  const candidates = await previousGraphNodes(input.domain, input.runDir);
  const exactNode = candidates.find(
    (candidate) => candidate.node.nodeId === input.classification.nodeId,
  );
  const sameUrlShape = candidates.find(
    (candidate) => candidate.node.urlShape === input.capture.urlShape,
  );
  const match = exactNode || sameUrlShape;
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (exactNode) reasons.push("matched existing node id");
  if (!exactNode && sameUrlShape) reasons.push("matched existing URL shape");
  if (!match) blockers.push("no existing node evidence matched");
  return {
    schemaVersion: 1,
    method: "matchExistingNode",
    stable: true,
    proposedNodeId: input.classification.nodeId,
    matched: Boolean(match),
    matchedNodeId: match?.node.nodeId,
    matchedCaptureId: match?.node.captureId,
    matchedSurfaceJsonPath: match?.node.evidence.surfaceJsonPath,
    confidence: exactNode ? 0.95 : sameUrlShape ? 0.82 : 0,
    reasons,
    blockers,
    artifactPath: "",
  };
}

async function diffSurfaceControls(input: {
  capture: SurfaceCapture;
  nodeMatch?: NodeMatchArtifact;
}): Promise<ControlDiffArtifact> {
  const previous =
    input.nodeMatch?.matchedSurfaceJsonPath &&
    (await readJsonFile<SurfaceCapture>(
      input.nodeMatch.matchedSurfaceJsonPath,
    ));
  if (!previous) {
    return {
      schemaVersion: 1,
      method: "diffSurfaceControls",
      stable: true,
      toCaptureId: input.capture.captureId,
      matchedNodeId: input.nodeMatch?.matchedNodeId,
      summary: emptyControlSummary(input.capture.controls.length),
      changes: input.capture.controls.map((control) => ({
        status: "new_candidate",
        currentRef: control.ref,
        currentStableId: control.stableId,
        role: control.role,
        currentLabel: controlLabel(control),
        href: control.href,
        reason: "no previous matched surface evidence",
      })),
      blockers: ["no previous matched surface evidence"],
      artifactPath: "",
    };
  }

  const changes: ControlDiffChange[] = [];
  const matchedCurrent = new Set<string>();
  for (const previousControl of previous.controls) {
    const stable = input.capture.controls.find(
      (control) => control.stableId === previousControl.stableId,
    );
    if (stable) {
      matchedCurrent.add(stable.ref);
      changes.push({
        status: "stable",
        previousRef: previousControl.ref,
        currentRef: stable.ref,
        previousStableId: previousControl.stableId,
        currentStableId: stable.stableId,
        role: stable.role,
        previousLabel: controlLabel(previousControl),
        currentLabel: controlLabel(stable),
        href: stable.href,
        reason: "stable control id",
      });
      continue;
    }
    const sameSignature = input.capture.controls.find(
      (control) =>
        !matchedCurrent.has(control.ref) &&
        controlSignature(control) === controlSignature(previousControl),
    );
    if (sameSignature) {
      matchedCurrent.add(sameSignature.ref);
      changes.push({
        status: "drifted_selector",
        previousRef: previousControl.ref,
        currentRef: sameSignature.ref,
        previousStableId: previousControl.stableId,
        currentStableId: sameSignature.stableId,
        role: sameSignature.role,
        previousLabel: controlLabel(previousControl),
        currentLabel: controlLabel(sameSignature),
        href: sameSignature.href,
        reason: "same role/label/href with changed stable id",
      });
      continue;
    }
    const renamed = input.capture.controls.find(
      (control) =>
        !matchedCurrent.has(control.ref) &&
        control.role === previousControl.role &&
        Boolean(control.href) &&
        control.href === previousControl.href,
    );
    if (renamed) {
      matchedCurrent.add(renamed.ref);
      changes.push({
        status: "renamed",
        previousRef: previousControl.ref,
        currentRef: renamed.ref,
        previousStableId: previousControl.stableId,
        currentStableId: renamed.stableId,
        role: renamed.role,
        previousLabel: controlLabel(previousControl),
        currentLabel: controlLabel(renamed),
        href: renamed.href,
        reason: "same role/href with changed label",
      });
      continue;
    }
    changes.push({
      status: "missing",
      previousRef: previousControl.ref,
      previousStableId: previousControl.stableId,
      role: previousControl.role,
      previousLabel: controlLabel(previousControl),
      href: previousControl.href,
      reason: "previous control not found in current capture",
    });
  }

  for (const control of input.capture.controls) {
    if (matchedCurrent.has(control.ref)) continue;
    changes.push({
      status: "new_candidate",
      currentRef: control.ref,
      currentStableId: control.stableId,
      role: control.role,
      currentLabel: controlLabel(control),
      href: control.href,
      reason: "control not present in previous matched capture",
    });
  }

  return {
    schemaVersion: 1,
    method: "diffSurfaceControls",
    stable: true,
    fromCaptureId: previous.captureId,
    toCaptureId: input.capture.captureId,
    matchedNodeId: input.nodeMatch?.matchedNodeId,
    summary: summarizeControlChanges(changes),
    changes,
    blockers: [],
    artifactPath: "",
  };
}

async function reconcileEdges(input: {
  domain: Domain;
  runDir: string;
  classification: SurfaceClassification;
  candidateEdges: CandidateEdgesArtifact;
  nodeMatch?: NodeMatchArtifact;
}): Promise<EdgeReconciliationArtifact> {
  const previousEdges = input.nodeMatch?.matchedNodeId
    ? (await previousGraphEdges(input.domain, input.runDir)).filter(
        (edge) => edge.fromNodeId === input.nodeMatch?.matchedNodeId,
      )
    : [];
  const changes: EdgeReconciliationChange[] = [];
  const matchedCurrent = new Set<string>();
  for (const previous of previousEdges) {
    const stable = input.candidateEdges.edges.find(
      (edge) => edge.edgeId === previous.edgeId,
    );
    if (stable) {
      matchedCurrent.add(stable.edgeId);
      changes.push({
        status: "stable",
        previousEdgeId: previous.edgeId,
        currentEdgeId: stable.edgeId,
        previousLabel: previous.label,
        currentLabel: stable.label,
        href: stable.href,
        actionKind: stable.actionKind,
        reason: "stable edge id",
      });
      continue;
    }
    const sameSignature = input.candidateEdges.edges.find(
      (edge) =>
        !matchedCurrent.has(edge.edgeId) &&
        edgeSignature(edge) === edgeSignature(previous),
    );
    if (sameSignature) {
      matchedCurrent.add(sameSignature.edgeId);
      changes.push({
        status: "drifted_selector",
        previousEdgeId: previous.edgeId,
        currentEdgeId: sameSignature.edgeId,
        previousLabel: previous.label,
        currentLabel: sameSignature.label,
        href: sameSignature.href,
        actionKind: sameSignature.actionKind,
        reason: "same action signature with changed edge id",
      });
      continue;
    }
    const renamed = input.candidateEdges.edges.find(
      (edge) =>
        !matchedCurrent.has(edge.edgeId) &&
        edge.actionKind === previous.actionKind &&
        Boolean(edge.href) &&
        edge.href === previous.href,
    );
    if (renamed) {
      matchedCurrent.add(renamed.edgeId);
      changes.push({
        status: "renamed",
        previousEdgeId: previous.edgeId,
        currentEdgeId: renamed.edgeId,
        previousLabel: previous.label,
        currentLabel: renamed.label,
        href: renamed.href,
        actionKind: renamed.actionKind,
        reason: "same action href with changed label",
      });
      continue;
    }
    changes.push({
      status: "missing",
      previousEdgeId: previous.edgeId,
      previousLabel: previous.label,
      href: previous.href,
      actionKind: previous.actionKind,
      reason: "previous edge not found in current candidate edges",
    });
  }

  for (const edge of input.candidateEdges.edges) {
    if (matchedCurrent.has(edge.edgeId)) continue;
    changes.push({
      status: "new_candidate",
      currentEdgeId: edge.edgeId,
      currentLabel: edge.label,
      href: edge.href,
      actionKind: edge.actionKind,
      reason: previousEdges.length
        ? "edge not present in previous graph evidence"
        : "no previous edge evidence for matched node",
    });
  }

  return {
    schemaVersion: 1,
    method: "reconcileEdges",
    stable: true,
    fromNodeId: input.classification.nodeId,
    previousEdgeCount: previousEdges.length,
    currentEdgeCount: input.candidateEdges.edges.length,
    summary: summarizeEdgeChanges(changes),
    edges: changes,
    blockers: previousEdges.length ? [] : ["no previous edge evidence"],
    artifactPath: "",
  };
}

async function recordGraphMutation(input: {
  domain: Domain;
  runDir: string;
  capture: SurfaceCapture;
  classification: SurfaceClassification;
  candidateEdges: CandidateEdgesArtifact;
}): Promise<GraphMutationArtifact> {
  const graphPath = path.join(input.runDir, "graph-candidate.json");
  const node: GraphMutationArtifact["node"] = {
    nodeId: input.classification.nodeId,
    surfaceType: input.classification.surfaceType,
    url: input.capture.url,
    urlShape: input.capture.urlShape,
    title: input.capture.title,
    captureId: input.capture.captureId,
    surfaceHash: input.capture.hashes.surfaceHash,
    evidence: {
      surfaceJsonPath: path.join(input.capture.artifactDir, "surface.json"),
      markdownPath: input.capture.markdown.path,
      screenshotPath: input.capture.screenshot.path,
      screenshotOverlayPath: input.capture.screenshot.overlayPath,
      ariaSnapshotPath: input.capture.ariaSnapshot?.path,
    },
  };
  const existing = await readJsonFile<GraphCandidate>(graphPath);
  const replacedNodeIds = new Set(
    (existing?.nodes || [])
      .filter(
        (candidate) =>
          candidate.nodeId === node.nodeId ||
          candidate.urlShape === node.urlShape,
      )
      .map((candidate) => candidate.nodeId),
  );
  const graph: GraphCandidate = {
    schemaVersion: 1,
    domain: input.domain,
    updatedAt: new Date().toISOString(),
    nodes: [
      ...(existing?.nodes || []).filter(
        (candidate) => !replacedNodeIds.has(candidate.nodeId),
      ),
      node,
    ],
    edges: upsertBy(
      (existing?.edges || []).filter(
        (candidate) => !replacedNodeIds.has(candidate.fromNodeId),
      ),
      input.candidateEdges.edges,
      (item) => item.edgeId,
    ),
  };
  await writeJsonFile(graphPath, graph);
  return {
    schemaVersion: 1,
    method: "recordGraphMutation",
    stable: true,
    graphPath,
    node,
    edgeCount: input.candidateEdges.edges.length,
    blockers: [],
    artifactPath: "",
  };
}

function nodeIdFor(
  domain: Domain,
  surfaceType: SurfaceType,
  urlShape: string,
): string {
  if (domain === "ycombinator.com") {
    const ycNodeId = ycNodeIdFor(surfaceType, urlShape);
    if (ycNodeId) return ycNodeId;
  }
  if (surfaceType !== "unknown") return surfaceType;
  return `${slugifyName(domain)}_${slugifyName(urlShape) || "surface"}`;
}

function ycNodeIdFor(
  surfaceType: SurfaceType,
  urlShape: string,
): string | undefined {
  const rawPath = urlShape.replace(/^www\.ycombinator\.com/, "") || "/";
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const canonical: Partial<Record<SurfaceType, string>> = {
    yc_home: "/",
    yc_about: "/about",
    yc_companies: "/companies",
    yc_jobs: "/jobs",
    yc_careers: "/careers",
    yc_apply: "/apply",
    yc_blog: "/blog",
    yc_library: "/library",
    yc_library_search: "/library/search",
    yc_launches: "/launches",
    yc_partners: "/partners",
    yc_cofounder_matching: "/cofounder-matching",
    yc_investors: "/investors",
    yc_demo_day: "/demoday",
    yc_documents: "/documents",
    yc_faq: "/faq",
    yc_contact: "/contact",
    yc_press: "/press",
    yc_legal: "/legal",
    yc_software: "/software",
    yc_early_decision: "/early-decision",
    yc_security: "/security",
    yc_handshake: "/handshake",
  };
  if (surfaceType === "yc_deals" && (path === "/deal" || path === "/deals"))
    return "yc_deals";
  if (canonical[surfaceType] === path) return surfaceType;
  if (surfaceType.startsWith("yc_")) {
    return `yc_${slugifyName(urlShape) || "surface"}`;
  }
  return undefined;
}

function isLoginSurface(
  capture: SurfaceCapture,
  url: URL,
  text: string,
): boolean {
  if (
    url.pathname.includes("/login") ||
    url.pathname.includes("/uas/login") ||
    url.pathname.includes("/accounts/login") ||
    url.pathname.includes("/i/flow/login")
  ) {
    return true;
  }
  const loginText =
    text.includes("email or username") ||
    text.includes("continue with phone") ||
    (text.includes("password") &&
      (text.includes("log in") ||
        text.includes("sign in") ||
        text.includes("email or phone")));
  if (!loginText) return false;
  const hasPasswordControl = capture.controls.some((control) => {
    const label = `${control.name || ""} ${control.text || ""}`.toLowerCase();
    if (control.type === "password") return true;
    if (control.tag !== "input" && control.role !== "textbox") return false;
    return /\bpassword\b/.test(label);
  });
  if (!hasPasswordControl) return false;
  return capture.controls.some((control) => {
    const label = `${control.name || ""} ${control.text || ""}`.toLowerCase();
    return /\b(password|email|username|phone)\b/.test(label);
  });
}

function isInstagramHome(url: URL): boolean {
  return url.pathname === "/" || url.pathname === "/accounts/onetap/";
}

function isYcHome(url: URL): boolean {
  return url.pathname === "/" || url.pathname === "";
}

function isYcRootContentPage(
  url: URL,
  title: string,
  markdownPreview: string,
): boolean {
  if (url.pathname.split("/").filter(Boolean).length !== 1) return false;
  if (!/\|\s*Y Combinator\b/.test(title)) return false;
  return (
    /^#\s+/m.test(markdownPreview) || markdownPreview.includes("Y Combinator")
  );
}

function instagramProfileUsername(pathname: string): string | null {
  const match = pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (!match) return null;
  return [
    "accounts",
    "direct",
    "explore",
    "p",
    "reel",
    "stories",
    "about",
    "developer",
  ].includes(match[1])
    ? null
    : match[1];
}

function xProfileUsername(pathname: string): string | null {
  const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  if (!match) return null;
  return [
    "home",
    "explore",
    "notifications",
    "messages",
    "settings",
    "i",
    "compose",
    "login",
    "logout",
    "tos",
    "privacy",
  ].includes(match[1])
    ? null
    : match[1];
}

async function previousGraphNodes(
  domain: Domain,
  runDir: string,
): Promise<Array<{ node: GraphMutationArtifact["node"]; graphPath: string }>> {
  const graphs = await previousGraphCandidates(domain, runDir);
  return graphs.flatMap((graph) =>
    graph.value.nodes.map((node) => ({ node, graphPath: graph.path })),
  );
}

async function previousGraphEdges(
  domain: Domain,
  runDir: string,
): Promise<CandidateEdge[]> {
  const graphs = await previousGraphCandidates(domain, runDir);
  const byId = new Map<string, CandidateEdge>();
  for (const edge of graphs.flatMap((graph) => graph.value.edges)) {
    if (!byId.has(edge.edgeId)) byId.set(edge.edgeId, edge);
  }
  return [...byId.values()];
}

async function previousGraphCandidates(
  domain: Domain,
  runDir: string,
): Promise<Array<{ path: string; value: GraphCandidate }>> {
  const paths = [
    path.join(runDir, "graph-candidate.json"),
    ...(await graphCandidatePathsFromPreviousRuns(domain, runDir)),
  ];
  const out: Array<{ path: string; value: GraphCandidate }> = [];
  for (const graphPath of paths) {
    const value = await readJsonFile<GraphCandidate>(graphPath);
    if (value?.domain === domain) out.push({ path: graphPath, value });
  }
  return out;
}

async function graphCandidatePathsFromPreviousRuns(
  domain: Domain,
  runDir: string,
): Promise<string[]> {
  const runsDir = path.join(siteDir(domain), "exploration-runs");
  const entries: Dirent[] = await fs
    .readdir(runsDir, { withFileTypes: true })
    .catch((): Dirent[] => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, "graph-candidate.json"))
    .filter((graphPath) => path.dirname(graphPath) !== runDir)
    .sort()
    .reverse()
    .slice(0, 10);
}

function controlSignature(control: CapturedControl): string {
  return JSON.stringify({
    role: control.role,
    label: controlLabel(control).toLowerCase(),
    href: control.href || "",
  });
}

function controlLabel(control: CapturedControl): string {
  return control.name || control.text || control.href || control.ref;
}

function edgeSignature(edge: CandidateEdge): string {
  return JSON.stringify({
    actionKind: edge.actionKind,
    label: edge.label.toLowerCase(),
    href: edge.href || "",
    toHint: edge.toHint,
  });
}

function emptyControlSummary(
  newCandidate: number,
): ControlDiffArtifact["summary"] {
  return {
    stable: 0,
    driftedSelector: 0,
    renamed: 0,
    missing: 0,
    newCandidate,
  };
}

function summarizeControlChanges(
  changes: ControlDiffChange[],
): ControlDiffArtifact["summary"] {
  return {
    stable: changes.filter((change) => change.status === "stable").length,
    driftedSelector: changes.filter(
      (change) => change.status === "drifted_selector",
    ).length,
    renamed: changes.filter((change) => change.status === "renamed").length,
    missing: changes.filter((change) => change.status === "missing").length,
    newCandidate: changes.filter((change) => change.status === "new_candidate")
      .length,
  };
}

function summarizeEdgeChanges(
  changes: EdgeReconciliationChange[],
): EdgeReconciliationArtifact["summary"] {
  return {
    stable: changes.filter((change) => change.status === "stable").length,
    driftedSelector: changes.filter(
      (change) => change.status === "drifted_selector",
    ).length,
    renamed: changes.filter((change) => change.status === "renamed").length,
    missing: changes.filter((change) => change.status === "missing").length,
    newCandidate: changes.filter((change) => change.status === "new_candidate")
      .length,
  };
}

function upsertBy<T>(
  existing: T[],
  next: T | T[],
  keyFor: (item: T) => string,
): T[] {
  const byKey = new Map(existing.map((item) => [keyFor(item), item]));
  for (const item of Array.isArray(next) ? next : [next]) {
    byKey.set(keyFor(item), item);
  }
  return [...byKey.values()];
}
