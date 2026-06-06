export type Domain =
  | "instagram.com"
  | "linkedin.com"
  | "x.com"
  | "ycombinator.com";
export type StateId = string;
export type AtomId = string;
export type StepId = string;
export type ProcessName = string;
export type FallbackTapeId = string;
export type PromotionProposalId = string;
export type TaskId = string;
export type TaskSegmentId = string;

export interface InterruptHandler {
  name: string;
  dismissSelector: string;
}

export type StateKind =
  | "page"
  | "modal"
  | "panel"
  | "list"
  | "form"
  | "thread"
  | "unknown";

export type OpType =
  | "click"
  | "fill"
  | "submit"
  | "navigate"
  | "hover"
  | "select"
  | "upload";
export type StepStatus = "recorded" | "replayed" | "self_healed" | "drifted";
export type EvidenceKind = "screenshot" | "text";
export type VisualReviewVerdict = "passed" | "failed" | "unclear" | "pending";
export type FallbackStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "rerecord_requested";
export type FallbackOperationKind =
  | "open"
  | "goto"
  | "snapshot"
  | "click"
  | "dblclick"
  | "hover"
  | "fill"
  | "type"
  | "press"
  | "check"
  | "uncheck"
  | "select"
  | "upload"
  | "wait"
  | "eval"
  | "generate_locator"
  | "text"
  | "screenshot"
  | "record_step"
  | "run_code"
  | "cli";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CartographerLogger {
  log(level: LogLevel, event: string, context?: Record<string, unknown>): void;
}

export interface Atom {
  id: AtomId;
  description: string;
  accessibleName: string;
  selector: string;
  method?: string;
  xpathShape: string;
  surfaceContext?: string;
}

export interface StateFingerprint {
  hash: string;
  atomIds: AtomId[];
  urlShape: string;
  title?: string;
  atomCount: number;
}

export interface State {
  id: StateId;
  domain: Domain;
  url: string;
  kind: StateKind;
  fingerprint: StateFingerprint;
  atoms: Atom[];
  observedAt: string;
  evidencePath?: string;
}

export interface EvidenceArtifact {
  kind: EvidenceKind;
  label: string;
  path: string;
  selector?: string;
  createdAt: string;
}

export interface VisualReviewArtifact {
  schemaVersion: 1;
  id: string;
  domain: Domain;
  subject: {
    kind: "runtime_process" | "fallback_tape" | "fallback_operation";
    processName?: ProcessName;
    fallbackTapeId?: FallbackTapeId;
    operationId?: string;
    taskId?: TaskId;
  };
  status: "pending" | "reviewed" | "skipped";
  reviewer: "vlm" | "agent" | "manual";
  model?: string;
  source: {
    type: "final_screenshot";
    screenshotPath: string;
    url?: string;
    capturedAt: string;
  };
  question: string;
  expected: string;
  checks: string[];
  postconditions: Postcondition[];
  result?: {
    verdict: Exclude<VisualReviewVerdict, "pending">;
    confidence?: number;
    reason: string;
    reviewedAt: string;
  };
  createdAt: string;
}

export interface Action {
  selector: string;
  method?: string;
  arguments?: string[];
  description?: string;
}

export interface TapeStep {
  id: StepId;
  name: string;
  type: OpType;
  before: State;
  after: State;
  atomId: AtomId;
  instruction: string;
  actions: Action[];
  status: StepStatus;
  validationHash: string;
  validators?: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
  writesToPlatform: boolean;
  createdAt: string;
}

export interface SelectorDiagnosticCandidate {
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "playwright";
  stability: "strong" | "medium" | "weak";
  reason: string;
  matchCount?: number;
  score?: number;
  scoreReasons?: string[];
}

export interface StepSelectorDiagnostics {
  selected: SelectorDiagnosticCandidate;
  alternatives?: SelectorDiagnosticCandidate[];
}

export type StepValidator =
  | { type: "url_equals"; value: string }
  | { type: "url_contains"; value: string }
  | { type: "selector_exists"; selector: string }
  | { type: "text_contains"; selector: string; value: string }
  | { type: "scoped_text_contains"; selectors: string[]; value: string }
  | {
      type: "rendered_text_contains";
      selector: string;
      value: string;
      excludeSelectors?: string[];
    };

export interface ProcessOutput {
  name: string;
  source: "text";
  selector: string;
  description: string;
  transform?: {
    type: "raw_text" | "compact_lines" | "notification_rows";
    limit?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
  };
}

export type Postcondition = StepValidator;

export interface FallbackTape {
  id: FallbackTapeId;
  sourceFallbackTapeId?: FallbackTapeId;
  sourceOperationIndexes?: number[];
  domain: Domain;
  taskId?: TaskId;
  taskSegmentId?: TaskSegmentId;
  taskSegmentPath?: string;
  intent: string;
  sessionId?: string;
  source: "playwright_fallback" | "stagehand_fallback" | "imported_process";
  status: FallbackStatus;
  entry: State;
  steps: TapeStep[];
  operations?: FallbackOperation[];
  evidence: EvidenceArtifact[];
  visualReviews?: VisualReviewArtifact[];
  args: ProcessArg[];
  writesToPlatform: boolean;
  recordingStartedAt?: string;
  createdAt: string;
  completedAt: string;
  rejectedAt?: string;
  rejectedReason?: string;
  rerecordRequestedAt?: string;
  rerecordReason?: string;
  rerecordInstructions?: string;
  rerecordTargetCommandName?: ProcessName;
  promotedAt?: string;
  promotedProcessName?: ProcessName;
}

export interface FallbackOperation {
  id: string;
  kind: FallbackOperationKind;
  instruction: string;
  surface?: "fallback" | "cli";
  promotionEligible?: boolean;
  urlBefore?: string;
  urlAfter?: string;
  selector?: string;
  selectorKind?: "xpath" | "css" | "url" | "playwright" | "unknown";
  selectorCandidates?: SelectorDiagnosticCandidate[];
  writeGrounding?: WriteGroundingSummary;
  valuePlaceholder?: string;
  evidencePath?: string;
  evidencePaths?: Record<string, string>;
  evidenceSummaryPath?: string;
  evidenceSummary?: PlaywrightCliEvidenceSummary;
  visualReview?: VisualReviewArtifact;
  stepId?: StepId;
  command?: string;
  commandArgs?: string[];
  processName?: ProcessName;
  success?: boolean;
  failureReason?: string;
  writesToPlatform?: boolean;
  createdAt: string;
}

export interface PlaywrightCliEvidenceSummary {
  schemaVersion: 1;
  command: string;
  args: string[];
  success: boolean;
  urlBefore?: string;
  urlAfter?: string;
  title?: string;
  consoleSummary?: string;
  target?: {
    selectorArg?: string;
    ref?: string;
    role?: string;
    name?: string;
    href?: string;
  };
  counts: {
    refs: number;
    links: number;
    buttons: number;
    textboxes: number;
    snapshots: number;
  };
  controls: SnapshotControlSummary[];
  selectorCandidates: SelectorDiagnosticCandidate[];
  writeGrounding?: WriteGroundingSummary;
  actionDiscovery?: CachedActionDiscovery;
  warnings: string[];
  preview: string[];
  createdAt: string;
}

export interface SnapshotControlSummary {
  ref: string;
  role: string;
  name?: string;
  href?: string;
}

export interface WriteGroundingSummary {
  command: string;
  writeAdjacent: boolean;
  urlScope?: string;
  recommendedSelector?: string;
  promotionReady: boolean;
  candidates: WriteGroundingCandidate[];
  postconditionHints: Postcondition[];
  warnings: string[];
}

export interface WriteGroundingCandidate {
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "playwright";
  score: number;
  promotionReady: boolean;
  reasons: string[];
  penalties: string[];
  matchCount: number;
  visible: boolean;
  enabled: boolean;
  role?: string;
  accessibleName?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  ariaDescription?: string;
  contenteditable?: boolean;
  formOwner?: string;
  nearbyStableText?: string;
  urlScope?: string;
}

export interface CachedActionDiscovery {
  cacheKey: string;
  source: "deterministic_grounding";
  actions: CachedDiscoveredAction[];
}

export interface CachedDiscoveredAction {
  description: string;
  method: "click" | "fill" | "type" | "press";
  selector: string;
  arguments: string[];
  score: number;
  promotionReady: boolean;
}

export interface FallbackReviewPacket {
  id: FallbackTapeId;
  domain: Domain;
  taskId?: TaskId;
  taskSegmentId?: TaskSegmentId;
  taskSegmentPath?: string;
  intent: string;
  status: FallbackStatus;
  stepCount: number;
  writesToPlatform: boolean;
  args: ProcessArg[];
  evidence: EvidenceArtifact[];
  visualReviews?: VisualReviewArtifact[];
  evidencePreview: EvidencePreview[];
  reviewPath?: string;
  reviewRequestPath?: string;
  decisionSchemaPath?: string;
  decisionTemplatePath?: string;
  createReviewCommand: string;
  applyDecisionCommand?: string;
}

export type TaskFileStatus =
  | "open"
  | "recording"
  | "review_required"
  | "decision_required"
  | "decision_applied"
  | "closed";
export type TaskReviewStatus = "created" | "applied" | "stale";
export type TaskSegmentStatus =
  | "recording"
  | "saved"
  | "abandoned"
  | "promoted"
  | "rejected"
  | "deleted"
  | "rerecord_requested";

export interface TaskSegmentReference {
  segmentId: TaskSegmentId;
  segmentPath: string;
  intent: string;
  status: TaskSegmentStatus;
  fallbackTapeId?: FallbackTapeId;
  reviewPath?: string;
  abandonedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFile {
  schemaVersion: 1;
  taskId: TaskId;
  domain: Domain;
  intent: string;
  status: TaskFileStatus;
  taskPath: string;
  taskMarkdownPath: string;
  review?: TaskReviewState;
  segments: TaskSegmentReference[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  completionKind?: "normal" | "no_acquisition";
  completionReason?: string;
}

export interface TaskReviewState {
  reviewId: string;
  status: TaskReviewStatus;
  reviewPath: string;
  reviewRequestPath: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  coversFallbackTapeIds: FallbackTapeId[];
  createdAt: string;
  appliedAt?: string;
  staleAt?: string;
}

export interface TaskLifecycleGateResult {
  allowed: boolean;
  requiredAction?: string;
  reason?: string;
  command?: string;
}

export interface TaskSegmentFile {
  schemaVersion: 1;
  taskId: TaskId;
  segmentId: TaskSegmentId;
  domain: Domain;
  intent: string;
  status: TaskSegmentStatus;
  surface: "fallback";
  segmentPath: string;
  segmentMarkdownPath: string;
  eventJournalPath?: string;
  fallbackTapeId?: FallbackTapeId;
  fallbackTapePath?: string;
  reviewPath?: string;
  reviewRequestPath?: string;
  decisionSchemaPath?: string;
  decisionTemplatePath?: string;
  abandonedReason?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface FallbackPromotionSummary {
  fallbackTapeId: FallbackTapeId;
  domain: Domain;
  intent: string;
  status: FallbackStatus;
  source: FallbackTape["source"];
  sessionId?: string;
  writesToPlatform: boolean;
  args: ProcessArg[];
  recordingStartedAt?: string;
  completedAt: string;
  entryUrl: string;
  finalUrl: string;
  stepCount: number;
  operationCount: number;
  steps: FallbackStepSummary[];
  operations: FallbackOperation[];
  evidence: EvidencePreview[];
  visualReviews: VisualReviewArtifact[];
  mechanicalHints: MechanicalPromotionHints;
}

export interface DuplicateCandidate {
  processName: ProcessName;
  description: string;
  writesToPlatform: boolean;
  args: ProcessArg[];
  outputs: ProcessOutput[];
  postconditions: Postcondition[];
  reasons: string[];
}

export interface DuplicateJudgment {
  checked: true;
  duplicateOf: ProcessName | null;
  reasoning: string;
}

export interface FallbackStepSummary {
  id: StepId;
  name: string;
  type: OpType;
  instruction: string;
  beforeUrl: string;
  afterUrl: string;
  writesToPlatform: boolean;
  actions: FallbackActionSummary[];
  validators: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
  selectorWarnings: string[];
}

export interface FallbackActionSummary {
  method?: string;
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "playwright" | "unknown";
  arguments: string[];
}

export interface MechanicalPromotionHints {
  suggestedPostconditions: Postcondition[];
  riskFlags: string[];
  selectorWarnings: string[];
  textEvidenceSelectors: string[];
}

export type EasyToPromoteRank = "low" | "medium" | "high";

export type AcquisitionCandidateKind =
  | "navigation"
  | "state_transition"
  | "read_output"
  | "write_command"
  | "repair"
  | "remainder";

export interface ObservedText {
  text: string;
  label: string;
  evidencePath: string;
  operationIndex?: number;
  selector?: string;
}

export interface ObservedLink {
  text: string;
  href: string;
  evidencePath: string;
  operationIndex?: number;
}

export interface RepeatedTextPattern {
  name: string;
  values: string[];
  evidencePaths: string[];
  count: number;
}

export interface EvidenceProvenance {
  value: string;
  destinationOperationIndex: number;
  destinationEvidencePath?: string;
  sourceEvidencePaths: string[];
  matchedPatterns: string[];
}

export interface PageKindSignal {
  kind:
    | "instagram_profile"
    | "instagram_search_results"
    | "instagram_direct_inbox"
    | "instagram_direct_thread"
    | "unknown";
  confidence: EasyToPromoteRank;
  url?: string;
  evidencePath?: string;
  reason: string;
}

export interface EvidenceDigest {
  observedTexts: ObservedText[];
  observedLinks: ObservedLink[];
  observedControls: SnapshotControlSummary[];
  repeatedTextPatterns: RepeatedTextPattern[];
  pageKinds: PageKindSignal[];
  finalOutputProvenance: EvidenceProvenance[];
}

export interface OperationDigest {
  operationCount: number;
  executableCount: number;
  writeCount: number;
  snapshotCount: number;
  weakSelectorCount: number;
  urlsVisited: string[];
}

export interface AcquisitionCandidate {
  id: string;
  reviewItemId: string;
  fallbackTapeId: FallbackTapeId;
  kind: AcquisitionCandidateKind;
  operationIndexes?: number[];
  evidencePaths: string[];
  deterministicReason: string;
  suggestedCommandName?: ProcessName;
  suggestedDescription?: string;
  suggestedArgs?: ProcessArg[];
  suggestedOutputs?: ProcessOutput[];
  suggestedValueBindings?: OperationValueBinding[];
  suggestedPostconditions?: Postcondition[];
  suggestedStateScope?: CommandStateScope;
  riskFlags: string[];
  harnessEasyToPromote: EasyToPromoteRank;
  agentMustRate: true;
}

export interface AcquisitionObligation {
  id: string;
  severity: "blocker" | "warning" | "info";
  code:
    | "data_used_without_output_contract"
    | "repeated_snapshot_scrape"
    | "write_action_without_promotable_candidate"
    | "weak_write_selectors"
    | "task_metric_without_read_candidate"
    | "candidate_missing_disposition"
    | "snapshot_only_final_answer";
  message: string;
  evidencePaths: string[];
  relatedCandidateIds: string[];
  requiredDisposition:
    | "promote_or_reject"
    | "rerecord_or_reject"
    | "acknowledge";
}

export interface FallbackAcquisitionScorecard {
  easyToPromote: EasyToPromoteRank;
  acquisitionQuality: "strong" | "acceptable" | "thin" | "poor";
  candidateCount: number;
  highValueCandidateCount: number;
  obligationCount: number;
  blockerCount: number;
  dataOutputCandidateCount: number;
  writeCandidateCount: number;
  reasoning: string;
}

export interface TaskAcquisitionScorecard {
  executionStatus: "complete" | "incomplete";
  lifecycleStatus: TaskFileStatus;
  promotedCount: number;
  rejectedCount: number;
  deletedCount: number;
  rerecordRecommendedCount: number;
  dataUsedWithoutOutputCount: number;
  writeCandidatesRejectedOrWeakCount: number;
  candidateCoverage: "complete" | "partial" | "thin";
  acquisitionQuality: "strong" | "acceptable" | "thin" | "poor";
  reasoning: string;
}

export interface CompiledFallbackReview {
  fallbackTapeId: FallbackTapeId;
  intent: string;
  status: FallbackStatus;
  writesToPlatform: boolean;
  operationDigest: OperationDigest;
  evidenceDigest: EvidenceDigest;
  candidates: AcquisitionCandidate[];
  obligations: AcquisitionObligation[];
  scorecard: FallbackAcquisitionScorecard;
  deepEvidencePaths: string[];
}

export interface CompiledTaskReview {
  schemaVersion: 1;
  domain: Domain;
  taskId: TaskId;
  taskIntent: string;
  existingCommands: ProcessTapeSummary[];
  scorecard: TaskAcquisitionScorecard;
  obligations: AcquisitionObligation[];
  fallbacks: CompiledFallbackReview[];
  prompt: string;
}

export interface EvidencePreview {
  kind: EvidenceKind;
  label: string;
  path: string;
  selector?: string;
  preview?: string;
}

export interface PromotionProposal {
  id: PromotionProposalId;
  fallbackTapeId: FallbackTapeId;
  domain: Domain;
  decision: "promote" | "reject";
  commandName?: ProcessName;
  description?: string;
  args?: ProcessArg[];
  outputs?: ProcessOutput[];
  stateScope?: CommandStateScope;
  postconditions?: Postcondition[];
  writesToPlatform?: boolean;
  reason: string;
  reviewer: "agent" | "model";
  policyFindings?: PromotionPolicyFinding[];
  createdAt: string;
  appliedAt?: string;
}

export interface FallbackTapeStore {
  list(domain: Domain): Promise<FallbackTape[]>;
  load(domain: Domain, id: FallbackTapeId): Promise<FallbackTape | null>;
  save(tape: FallbackTape): Promise<void>;
  markPromoted(
    domain: Domain,
    id: FallbackTapeId,
    processName: ProcessName,
  ): Promise<void>;
  reject(domain: Domain, id: FallbackTapeId, reason: string): Promise<void>;
  delete(domain: Domain, id: FallbackTapeId): Promise<void>;
  requestRerecord(
    domain: Domain,
    id: FallbackTapeId,
    input: {
      reason: string;
      instructions?: string;
      targetCommandName?: ProcessName;
    },
  ): Promise<void>;
}

export interface PromotionStore {
  list(domain: Domain): Promise<PromotionProposal[]>;
  save(proposal: PromotionProposal): Promise<void>;
  markApplied(domain: Domain, id: PromotionProposalId): Promise<void>;
}

export interface ProcessArg {
  name: string;
  required: boolean;
  description: string;
}

export interface ProcessTape {
  name: ProcessName;
  description: string;
  domain: Domain;
  promotionSource?: ProcessPromotionSource;
  entry: State;
  steps: TapeStep[];
  args: ProcessArg[];
  outputs?: ProcessOutput[];
  stateScope?: CommandStateScope;
  postconditions?: Postcondition[];
  writesToPlatform: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessPromotionSource {
  fallbackTapeId: FallbackTapeId;
  sourceFallbackTapeId?: FallbackTapeId;
  operationIndexes?: number[];
  operationIds?: string[];
  source: FallbackTape["source"];
}

export interface TapeCatalog {
  domain: Domain;
  version: 1;
  processes: Record<ProcessName, ProcessTapeSummary>;
  updatedAt: string;
}

export interface ProcessTapeSummary {
  name: ProcessName;
  description: string;
  stepCount: number;
  writesToPlatform: boolean;
  args: ProcessArg[];
  outputs?: ProcessOutput[];
  stateScope?: CommandStateScope;
  postconditions?: Postcondition[];
  updatedAt: string;
}

export interface CommandStateScope {
  preconditions?: Postcondition[];
  postconditions?: Postcondition[];
  autoEnterProcessName?: ProcessName;
  onUnmetPrecondition: "suggest_chain" | "fallback";
}

export interface SkillChainPlanStep {
  processName: ProcessName;
  reason: string;
  source: "precondition" | "target";
}

export interface SkillChainPlan {
  success: boolean;
  domain: Domain;
  targetProcessName: ProcessName;
  steps: SkillChainPlanStep[];
  fallbackRecommended: boolean;
  reason: string;
}

export interface StateScopedSkillPlanner {
  plan(input: {
    domain: Domain;
    targetProcessName: ProcessName;
    catalog: TapeCatalog;
  }): SkillChainPlan;
}

export type RuntimeArgs = Record<string, string | number | boolean>;

export interface BrowserSession {
  domain: Domain;
  currentUrl(): Promise<string>;
  goto(url: string): Promise<void>;
  observe(instruction: string): Promise<ObservedCandidate[]>;
  act(candidate: ObservedCandidate, args?: RuntimeArgs): Promise<ActOutcome>;
  actRaw(action: Action, args?: RuntimeArgs): Promise<ActOutcome>;
  exists(selector: string): Promise<boolean>;
  readText(selector?: string): Promise<string>;
  readTextExcluding(
    selector: string,
    excludeSelectors: string[],
  ): Promise<string>;
  isVisible(selector: string): Promise<boolean>;
  isEnabled(selector: string): Promise<boolean>;
  scrollIntoView(selector: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  waitForSettle(): Promise<void>;
  screenshot(label: string): Promise<string>;
  waitForUser(label: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSessionFactory {
  launch(domain: Domain, options: LaunchOptions): Promise<BrowserSession>;
}

export interface LaunchOptions {
  browser: "local" | "browserbase";
  cacheDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
  taskId?: TaskId;
  profile?: string;
}

export interface ObservedCandidate {
  id: string;
  instruction: string;
  action: Action;
  atom: Atom;
  risk: "unknown";
}

export interface ActOutcome {
  success: boolean;
  message: string;
  actions: Action[];
}

export interface StateIdentity {
  capture(session: BrowserSession, label?: string): Promise<State>;
  fingerprint(atoms: Atom[], url: string, kind?: StateKind): StateFingerprint;
  canonicalize(candidates: ObservedCandidate[]): Atom[];
  diff(a: StateFingerprint, b: StateFingerprint): StateDiff;
}

export interface StateDiff {
  sameHash: boolean;
  addedAtomIds: AtomId[];
  removedAtomIds: AtomId[];
  stableAtomRatio: number;
}

export interface ManualRecorder {
  snapshot(label: string): Promise<State>;
  observe(instruction: string): Promise<ObservedCandidate[]>;
  act(candidateId: string, args?: RuntimeArgs): Promise<ActOutcome>;
  recordLastStep(
    stepName: string,
    options?: RecordStepOptions,
  ): Promise<TapeStep>;
  nameProcess(input: NameProcessInput): Promise<ProcessTape>;
  save(): Promise<TapeCatalog>;
}

export interface RecordStepOptions {
  writesToPlatform: boolean;
  type?: OpType;
}

export interface NameProcessInput {
  name: ProcessName;
  description: string;
  stepIds: StepId[];
  args?: ProcessArg[];
  writesToPlatform?: boolean;
}

export interface TapeStore {
  loadCatalog(domain: Domain): Promise<TapeCatalog | null>;
  loadProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null>;
  saveCatalog(catalog: TapeCatalog): Promise<void>;
  saveProcess(process: ProcessTape): Promise<void>;
}

export interface LoadedSkillset {
  domain: Domain;
  catalog: TapeCatalog;
  processes: Record<ProcessName, ProcessTape>;
  loadedAt: string;
}

export interface SkillRegistry {
  preload(domain: Domain): Promise<LoadedSkillset>;
  refresh(domain: Domain): Promise<LoadedSkillset>;
  getProcess(domain: Domain, name: ProcessName): Promise<ProcessTape | null>;
  listProcesses(domain: Domain): Promise<ProcessTapeSummary[]>;
}

export interface StateActionCache {
  get(key: StateActionCacheKey): Promise<StateActionCacheEntry | null>;
  put(entry: StateActionCacheEntry): Promise<void>;
  markDrifted(key: StateActionCacheKey, reason: string): Promise<void>;
}

export interface StateActionCacheKey {
  domain: Domain;
  beforeStateId: StateId;
  atomId: AtomId;
}

export interface StateActionCacheEntry extends StateActionCacheKey {
  version: 1;
  afterStateId: StateId;
  instruction: string;
  actions: Action[];
  validationHash: string;
  status: StepStatus;
  writesToPlatform: boolean;
  updatedAt: string;
}

export interface BrowserFallbackRecorder {
  open(): Promise<void>;
  close(): Promise<void>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string, argName?: string): Promise<void>;
  text(selector?: string): Promise<string>;
  screenshot(label: string): Promise<string>;
  recordLastStep(name: string, options: RecordStepOptions): Promise<TapeStep>;
  createFallbackTape(input: CreateFallbackTapeInput): Promise<FallbackTape>;
}

export type FallbackEngineName = "playwright";

export interface FallbackEngine {
  name: FallbackEngineName;
  record(input: FallbackEngineRecordInput): Promise<FallbackTape>;
}

export interface FallbackEngineRecordInput {
  domain: Domain;
  intent: string;
  args?: ProcessArg[];
  writesToPlatform: boolean;
}

export interface CreateFallbackTapeInput {
  intent: string;
  argNames: string[];
  writesToPlatform: boolean;
}

export interface ElementLocatorStrategy {
  locate(input: LocateElementInput): Promise<LocatedElement>;
}

export interface LocateElementInput {
  selector: string;
  actionDescription: string;
}

export interface LocatedElement {
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "playwright";
  description: string;
  alternatives?: SelectorCandidate[];
}

export interface SelectorCandidate {
  selector: string;
  selectorKind: "xpath" | "css" | "playwright";
  stability: "strong" | "medium" | "weak";
  reason: string;
  matchCount?: number;
}

export interface SelectorPolicy {
  choose(candidates: SelectorCandidate[]): SelectorCandidate;
}

export interface ValidationResult {
  passed: boolean;
  failures: string[];
  checks?: ValidationCheck[];
}

export interface ValidationCheck {
  type: StepValidator["type"];
  passed: boolean;
  expected: string;
  observed?: string;
  selector?: string;
}

export interface ReplayValidator {
  validate(
    session: BrowserSession,
    validators?: StepValidator[],
  ): Promise<ValidationResult>;
}

export interface EvidenceStore {
  captureScreenshot(input: CaptureScreenshotInput): Promise<EvidenceArtifact>;
  captureText(input: CaptureTextInput): Promise<EvidenceArtifact>;
}

export interface CaptureScreenshotInput {
  domain: Domain;
  label: string;
  screenshot: () => Promise<Buffer>;
}

export interface CaptureTextInput {
  domain: Domain;
  label: string;
  selector: string;
  text: string;
}

export interface FallbackReviewer {
  review(domain: Domain): Promise<FallbackReviewResult>;
  inspect(domain: Domain, id: FallbackTapeId): Promise<FallbackReviewPacket>;
}

export interface FallbackReviewResult {
  existingProcesses: ProcessName[];
  unpromotedFallbacks: FallbackReviewPacket[];
}

export type PromotionPolicyFindingSeverity = "error" | "warning";

export interface PromotionPolicyFinding {
  severity: PromotionPolicyFindingSeverity;
  code: string;
  message: string;
}

export interface PromotionPolicyInput {
  tape: FallbackTape;
  commandName: ProcessName;
  description: string;
  outputs?: ProcessOutput[];
  stateScope?: CommandStateScope;
  postconditions?: Postcondition[];
  existingProcesses: ProcessTapeSummary[];
  duplicateJudgment?: DuplicateJudgment;
}

export interface PromotionPolicyDecision {
  accepted: boolean;
  writesToPlatform: boolean;
  effectivePostconditions?: Postcondition[];
  findings: PromotionPolicyFinding[];
  reason: string;
}

export interface PromotionPolicy {
  evaluate(input: PromotionPolicyInput): PromotionPolicyDecision;
}

export type PromotionDecisionConfidence = "low" | "medium" | "high";

export type PromotionDecision =
  | {
      action: "promote";
      fallbackTapeId: FallbackTapeId;
      reviewItemId?: string;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      agentEasyToPromote?: EasyToPromoteRank;
      duplicateJudgment?: DuplicateJudgment;
      candidateSliceId?: string;
      operationIndexes?: number[];
      args?: ProcessArg[];
      valueBindings?: OperationValueBinding[];
      commandName: ProcessName;
      description: string;
      stateScope?: CommandStateScope;
      postconditions: Postcondition[];
      outputs?: ProcessOutput[];
    }
  | {
      action: "reject";
      fallbackTapeId: FallbackTapeId;
      reviewItemId?: string;
      candidateSliceId?: string;
      operationIndexes?: number[];
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      agentEasyToPromote?: EasyToPromoteRank;
      duplicateJudgment?: DuplicateJudgment;
      rejectReason: string;
    }
  | {
      action: "delete";
      fallbackTapeId: FallbackTapeId;
      reviewItemId?: string;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      agentEasyToPromote?: EasyToPromoteRank;
    }
  | {
      action: "rerecord";
      fallbackTapeId: FallbackTapeId;
      reviewItemId?: string;
      candidateSliceId?: string;
      operationIndexes?: number[];
      reasoning: string;
      confidence: PromotionDecisionConfidence;
      agentEasyToPromote?: EasyToPromoteRank;
      rerecordReason: string;
      rerecordInstructions?: string;
      suggestedCommandName?: ProcessName;
    };

export interface OperationValueBinding {
  operationIndex: number;
  argName: string;
  target?: "argument" | "selector";
}

export interface PromotionBatchDecision {
  action: "review_batch";
  taskId: TaskId;
  reasoning: string;
  confidence: PromotionDecisionConfidence;
  scorecardReview?: {
    acquisitionQuality: "strong" | "acceptable" | "thin" | "poor";
    reasoning: string;
  };
  obligationDispositions?: Array<{
    obligationId: string;
    action: "promote" | "reject" | "delete" | "rerecord" | "acknowledge";
    relatedReviewItemIds?: string[];
    reasoning: string;
  }>;
  decisions: PromotionDecision[];
}

export type PromotionDecisionFile = PromotionDecision | PromotionBatchDecision;

export interface PromotionDecisionSchema {
  schemaVersion: 1;
  schema: Record<string, unknown>;
}

export interface PromotionReviewRequest {
  schemaVersion: 1;
  domain: Domain;
  fallbackTapeId: FallbackTapeId;
  prompt: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  reviewPath: string;
  reviewPacket: FallbackReviewPacket;
  fallbackSummary: FallbackPromotionSummary;
  acquisition?: CompiledFallbackReview;
  existingCommands: ProcessTapeSummary[];
  duplicateCandidates: DuplicateCandidate[];
  policy: {
    name: "v1";
    hardRules: string[];
    advisoryRules: string[];
  };
}

export interface PromotionReviewArtifacts {
  reviewPath: string;
  reviewRequestPath: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  request: PromotionReviewRequest;
  decisionSchema: PromotionDecisionSchema;
  decisionTemplate: PromotionDecision;
}

export interface TaskPromotionReviewArtifacts {
  reviewPath: string;
  reviewRequestPath: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  request: TaskPromotionReviewRequest;
  decisionSchema: PromotionDecisionSchema;
  decisionTemplate: PromotionBatchDecision;
}

export interface CandidateOperationSlice {
  id: string;
  reviewItemId: string;
  kind: CandidateOperationSliceKind;
  fallbackTapeId: FallbackTapeId;
  operationIndexes: number[];
  mechanicalReason: string;
  suggestedCommandName?: ProcessName;
  suggestedDescription?: string;
  suggestedArgs?: ProcessArg[];
  suggestedValueBindings?: OperationValueBinding[];
  suggestedPostconditions?: Postcondition[];
  suggestedStateScope?: CommandStateScope;
  suggestedOutputs?: ProcessOutput[];
  riskFlags?: string[];
}

export type CandidateOperationSliceKind =
  | "navigation"
  | "open_and_read"
  | "state_transition"
  | "write_and_verify"
  | "read"
  | "primitive"
  | "misc";

export interface IndexedFallbackOperation extends FallbackOperation {
  operationIndex: number;
}

export interface TaskFallbackReviewItem {
  fallbackTapeId: FallbackTapeId;
  taskSegmentId?: TaskSegmentId;
  taskSegmentPath?: string;
  intent: string;
  status: FallbackStatus;
  writesToPlatform: boolean;
  args: ProcessArg[];
  operations: IndexedFallbackOperation[];
  candidateSlices: CandidateOperationSlice[];
  reviewRequestPath?: string;
  reviewPath?: string;
  duplicateCandidates: DuplicateCandidate[];
  riskFlags: string[];
  acquisition?: CompiledFallbackReview;
}

export interface TaskPromotionReviewRequest {
  schemaVersion: 1;
  domain: Domain;
  taskId: TaskId;
  prompt: string;
  decisionSchemaPath: string;
  decisionTemplatePath: string;
  reviewRequestPath: string;
  reviewPath: string;
  existingCommands: ProcessTapeSummary[];
  fallbacks: TaskFallbackReviewItem[];
  acquisition?: CompiledTaskReview;
  policy: {
    name: "v1";
    hardRules: string[];
    advisoryRules: string[];
  };
}

export interface PromotionDecisionApplyResult {
  decision: PromotionDecisionFile;
  agentContractDelta?: AgentContractDelta;
  result:
    | { action: "promote"; promotion: PromotionResult }
    | { action: "reject"; rejected: FallbackTapeId; reason: string }
    | { action: "delete"; deleted: FallbackTapeId }
    | {
        action: "rerecord";
        fallbackTapeId: FallbackTapeId;
        reason: string;
        instructions?: string;
        suggestedCommandName?: ProcessName;
      };
}

export interface PromotionDecisionApplier {
  apply(
    domain: Domain,
    decision: PromotionDecision,
  ): Promise<PromotionDecisionApplyResult>;
}

export interface PromotionOptions {
  commandName: ProcessName;
  description: string;
  outputs?: ProcessOutput[];
  stateScope?: CommandStateScope;
  postconditions?: Postcondition[];
  duplicateJudgment?: DuplicateJudgment;
}

export interface ReusableCommandReference {
  cliPath: string;
  command: string;
  dryRunCommand?: string;
  helpCommand: string;
  skillPath: string;
  manifestPath?: string;
}

export interface AgentContractDelta {
  schemaVersion: 1;
  kind: "command_added";
  domain: Domain;
  commandName: string;
  processName: ProcessName;
  description: string;
  writesToPlatform: boolean;
  args: ProcessArg[];
  outputs: ProcessOutput[];
  postconditions: Postcondition[];
  reusableCommand: ReusableCommandReference;
  refreshCommands: string[];
  agentInstruction: string;
}

export interface PromotionResult {
  proposal: PromotionProposal;
  processName: ProcessName;
  cliCommandName: string;
  reusableCommand: ReusableCommandReference;
  agentContractDelta: AgentContractDelta;
  policy: PromotionPolicyDecision;
  replay: PromotionReplayResult;
  emittedCli: CliEmitterResult;
  emittedSkillPath: string;
  emittedManifestPath?: string;
  exposedSkillPath: string;
  exposedManifestPath?: string;
}

export interface PromotionReplayResult {
  status: "passed" | "skipped";
  reason: string;
  processName: ProcessName;
  taskId?: TaskId;
  postconditionsPassed?: boolean;
  executedStepCount?: number;
}

export interface SkillPromoter {
  promote(
    domain: Domain,
    fallbackTapeId: FallbackTapeId,
    options: PromotionOptions,
  ): Promise<PromotionResult>;
}

export interface EndOfTaskReviewInput {
  domain: Domain;
  taskStartedAt?: string;
}

export interface EndOfTaskReviewResult {
  review: FallbackReviewResult;
}

export interface EndOfTaskReviewer {
  reviewCompletedTask(
    input: EndOfTaskReviewInput,
  ): Promise<EndOfTaskReviewResult>;
}

export interface CartographerRuntime {
  runProcess(input: RunProcessInput): Promise<RunProcessResult>;
}

export interface RunProcessInput {
  domain: Domain;
  processName: ProcessName;
  args?: RuntimeArgs;
  taskId?: TaskId;
  confirmWrite: boolean;
  dryRun: boolean;
}

export interface RunProcessResult {
  success: boolean;
  processName: ProcessName;
  executedStepIds: StepId[];
  driftedStepIds: StepId[];
  outputs?: Record<string, string>;
  execution?: RunExecutionResult;
  preconditions?: PostconditionResult;
  postconditions?: PostconditionResult;
  drift?: DriftReport;
  visualReview?: VisualReviewArtifact;
  failure?: RunFailure;
  suggestedAutoEnterProcessName?: ProcessName;
  fallbackRecommended?: boolean;
  message: string;
}

export interface RunExecutionResult {
  completed: boolean;
  stepCount: number;
  executedStepCount: number;
  actionFailures: ActionFailure[];
}

export interface ActionFailure {
  stepId: StepId;
  stepName: string;
  method?: string;
  selector: string;
  message: string;
  diagnosticScreenshotPath?: string;
}

export interface PostconditionResult {
  required: boolean;
  passed: boolean;
  checks: ValidationCheck[];
}

export interface DriftReport {
  detected: boolean;
  severity: "none" | "warning";
  steps: DriftStepReport[];
}

export interface DriftStepReport {
  stepId: StepId;
  stepName: string;
  expected: StateFingerprint;
  observed: StateFingerprint;
  stableAtomRatio: number;
  validationFailures: string[];
  validationChecks: ValidationCheck[];
}

export type RunFailure =
  | { kind: "action_failed"; reason: string }
  | { kind: "precondition_failed"; reason: string }
  | { kind: "postcondition_failed"; reason: string }
  | { kind: "missing_args"; reason: string }
  | { kind: "write_confirmation_required"; reason: string }
  | { kind: "unknown_process"; reason: string };

export interface CliEmitter {
  emit(input: CliEmitterInput): Promise<CliEmitterResult>;
}

export interface CliEmitterInput {
  domain: Domain;
  tapeDir: string;
  outputPath: string;
  binName: string;
}

export interface CliEmitterResult {
  outputPath: string;
  commandCount: number;
  commands: string[];
}
