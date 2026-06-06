import type { Domain, TaskId } from "../contracts.js";

export type ExplorationGoalName =
  | "instagram_home_feed"
  | "instagram_search"
  | "instagram_notifications"
  | "instagram_dm_inbox"
  | "instagram_dm_composer"
  | "linkedin_home_feed"
  | "linkedin_search_results"
  | "linkedin_messaging"
  | "linkedin_notifications"
  | "linkedin_my_network"
  | "x_home"
  | "x_explore"
  | "x_notifications"
  | "x_messages"
  | "yc_home"
  | "yc_about"
  | "yc_companies"
  | "yc_jobs"
  | "yc_apply"
  | "yc_blog";

export type HarnessMethodName =
  | "captureSurface"
  | "classifySurface"
  | "matchExistingNode"
  | "diffSurfaceControls"
  | "extractCandidateEdges"
  | "reconcileEdges"
  | "recordGraphMutation";

export interface HarnessRunConfig {
  domain: Domain;
  maxDepth?: number;
  maxNavigationEdgesPerSurface?: number;
  maxCaptures?: number;
  taskId?: TaskId;
  goal?: ExplorationGoalName;
  profile?: string;
  resumeRunDir?: string;
}

export interface HarnessCrawlPolicy {
  maxDepth: number;
  maxNavigationEdgesPerSurface: number;
  maxCaptures: number;
  executeClicks: false;
  sameDomainOnly: true;
  followWriteRisk: "none";
}

export interface HarnessCaptureSummary {
  captureId: string;
  surfaceJsonPath: string;
  markdownPath: string;
  screenshotPath: string;
  screenshotOverlayPath?: string;
  classificationPath?: string;
  nodeMatchPath?: string;
  controlDiffPath?: string;
  candidateEdgesPath?: string;
  edgeReconciliationPath?: string;
  graphMutationPath?: string;
  controlCount: number;
  controlGroupCount: number;
  candidateEdgeCount?: number;
  url: string;
  urlShape: string;
  surfaceType?: string;
  depth: number;
  parentEdgeId?: string;
  warnings: string[];
}

export interface HarnessCrawlFailure {
  url: string;
  urlShape: string;
  depth: number;
  parentEdgeId?: string;
  attempts: number;
  error: string;
  failedAt: string;
}

export interface HarnessBrowserCloseResult {
  closed: boolean;
  recordPath: string;
  remainingTaskIds?: TaskId[];
}

export interface ExplorationHarnessResult {
  success: boolean;
  domain: Domain;
  runId: string;
  runDir: string;
  goal?: ExplorationGoalName;
  crawlPolicy: HarnessCrawlPolicy;
  captures: HarnessCaptureSummary[];
  failures?: HarnessCrawlFailure[];
  browser: HarnessBrowserCloseResult;
}
