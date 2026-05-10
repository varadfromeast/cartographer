export const PROMOTION_REVIEW_PROMPT = `You are reviewing a Cartographer browser fallback tape for CLI skill promotion.

Your job is reasoning only. Do not run promotion, rejection, deletion, browser, or shell commands yourself.

Return exactly one JSON object matching PromotionDecision.

Promote only if:
- the tape captures a reusable operation, not a one-off user task
- the command name describes the actual repeatable operation
- the tape is repeatable from its recorded entry state
- final postconditions deterministically prove success
- write behavior is correctly marked and safe behind --confirm-write
- read/data commands declare explicit outputs
- duplicate candidates have been checked and the fallback is distinct from them

Acquisition bias:
- prefer deterministic browser/evidence operations that the agent can reuse
- name commands by the evidence they collect or browser state they reach
- prefer selector-backed textual outputs over screenshots whenever the evidence
  is text or DOM-readable
- use screenshots only for inherently visual evidence or supplemental context
- do not promote semantic judgments, lead scores, business classifications, or
  broad research goals as commands

Reject if:
- the tape depends on transient content, private accidental state, or brittle DOM position
- the broader user task was completed but the reusable operation is unclear
- postconditions or outputs are insufficient
- write behavior does not have a clear safety boundary
- an existing command already covers the same browser capability
- the proposed command name describes agent reasoning instead of deterministic browser/evidence collection
- a read/evidence command could return selector-backed text but declares only a screenshot or no output

Delete only if:
- the tape is noise or should not be retained.

Cartographer will validate your JSON decision with PromotionPolicy and apply all deterministic mutations.`;

export const TASK_PROMOTION_REVIEW_PROMPT = `You are reviewing all Cartographer fallback tapes for one task.

Your job is reasoning only. Do not run promotion, rejection, deletion, browser, or shell commands yourself.

Return exactly one JSON object matching PromotionBatchDecision:
- action must be "review_batch"
- include taskId, reasoning, confidence, and decisions[]
- each item in decisions[] is one PromotionDecision for one fallback slice or whole fallback
- one fallback may produce multiple promote/reject decisions when it contains multiple independent reusable slices
- evaluate candidate slices independently; noisy sibling operations do not disqualify a clean slice
- every candidate with suggestedCommandName and suggestedPostconditions is promotion-ready: promote it or explicitly reject that slice

For promote decisions:
- promote small deterministic browser/evidence commands, not broad user goals
- prefer exact operation slices over whole noisy tapes
- use reviewItemId and candidateSliceId when a proposed candidate is correct
- use operationIndexes for a custom slice; indexes are zero-based from the fallback operations array
- include args when a command needs runtime values
- include valueBindings with target "argument" when a fill operation should use an arg instead of the literal recorded value
- include valueBindings with target "selector" when a selector literal should become an arg, for example title="%threadName%"
- do not reject a clean slice only because the recorded literal is task-specific when suggestedValueBindings parameterize that literal
- reject literal one-off URL navigation candidates unless they are converted into a generic parameterized command such as open_profile_by_username
- include deterministic postconditions; write commands require explicit postconditions
- include stateScope when a command is only valid in a specific browser state, such as inbox or DM thread
- no stateScope means globally callable; do not add scope to direct URL/global navigation commands
- include duplicateJudgment when duplicate candidates are surfaced

For reject decisions:
- reject noisy, one-off, private, transient, unsafe, or semantically broad slices
- reject exact duplicate command candidates by default and use the existing CLI command
- reject the remaining whole fallback with reviewItemId "<fallbackTapeId>:fallback" when useful slices were handled separately
- reject when no operation slice is independently replayable
- do not use whole-fallback risk flags as the reason to reject a clean operation slice

For delete decisions:
- delete only when the fallback should not be retained.

Cartographer will validate your JSON decision and apply deterministic catalog/CLI mutations only in a separate apply command.`;

export const PROMOTION_POLICY_HARD_RULES = [
  "command name must be snake_case and unique",
  "fallback tape must have succeeded and must not already be promoted",
  "promotion must identify at least one recorded step or exact operationIndexes for an operation slice",
  "description must explicitly describe what the command does",
  "write commands are write-protected if the tape or any step writes",
  "deterministic final postconditions are required",
  "write promotions require explicit postconditions",
  "if stateScope is present, it must declare at least one precondition",
  "stateScope.autoEnterProcessName must point to an existing non-write command",
  "runtime placeholders must have declared args",
  "output contracts must have valid names, selectors, and descriptions",
  "if duplicate candidates are surfaced, promotion requires explicit duplicateJudgment",
];

export const PROMOTION_POLICY_ADVISORY_RULES = [
  "the agent is responsible for deciding whether the tape is semantically generic and reusable",
  "the agent is responsible for deciding whether surfaced duplicate candidates already cover the fallback capability",
  "evaluate operation slices independently; noisy sibling operations do not disqualify clean slices",
  "promotion-ready candidate slices should be promoted or explicitly rejected before rejecting the whole fallback",
  "prefer deterministic browser/evidence commands over semantic workflow commands",
  "prefer selector-backed textual outputs over screenshots for read/evidence commands",
  "non-write commands without outputs are navigation/state commands only",
  "state-scoped commands should expose the narrow state they require; global commands should omit stateScope",
  "prefer rejecting a broad task fallback and promoting only a smaller reusable sub-operation",
];
