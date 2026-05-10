import type { Action } from "@browserbasehq/stagehand";

export type Domain = "instagram.com";
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

export type OpType = "click" | "fill" | "submit" | "navigate";
export type StepStatus = "recorded" | "replayed" | "self_healed" | "drifted";
export type EvidenceKind = "screenshot" | "text";
export type FallbackStatus = "succeeded" | "failed" | "rejected";
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
}

export interface StepSelectorDiagnostics {
  selected: SelectorDiagnosticCandidate;
  alternatives?: SelectorDiagnosticCandidate[];
}

export type StepValidator =
  | { type: "url_equals"; value: string }
  | { type: "url_contains"; value: string }
  | { type: "selector_exists"; selector: string }
  | { type: "text_contains"; selector: string; value: string };

export interface ProcessOutput {
  name: string;
  source: "text";
  selector: string;
  description: string;
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
  args: ProcessArg[];
  writesToPlatform: boolean;
  recordingStartedAt?: string;
  createdAt: string;
  completedAt: string;
  rejectedAt?: string;
  rejectedReason?: string;
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
  valuePlaceholder?: string;
  evidencePath?: string;
  evidencePaths?: Record<string, string>;
  evidenceSummaryPath?: string;
  evidenceSummary?: PlaywrightCliEvidenceSummary;
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
  | "deleted";

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

export type FallbackEngineName = "stagehand" | "playwright";

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
      duplicateJudgment?: DuplicateJudgment;
      rejectReason: string;
    }
  | {
      action: "delete";
      fallbackTapeId: FallbackTapeId;
      reviewItemId?: string;
      reasoning: string;
      confidence: PromotionDecisionConfidence;
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
    | { action: "delete"; deleted: FallbackTapeId };
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
