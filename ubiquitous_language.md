# Cartographer Ubiquitous Language

Cartographer uses these terms consistently across code, docs, prompts, and
agent instructions.

## Core Terms

- **Cartographer**: a contract-first browser skill acquisition layer that emits
  per-site CLIs for agent-operated browser tasks that are too expensive or
  brittle to repeat through direct browser automation.
  _Avoid_: CLI emitter, browser macro recorder
- **Agent**: the external reasoning system. It reads the contract, chooses a
  command, decides when fallback is needed, and decides whether a fallback is
  reusable.
- **Command**: a named CLI capability exposed by the site CLI. The current
  Instagram catalog is empty; commands appear only after promotion.
- **Base Browser Command**: a Playwright-CLI-style browser primitive such as
  `open`, `goto`, `snapshot`, `click`, `fill`, or `eval`. Base browser commands
  are fallback substrate, not acquired site skills.
- **Acquired Site Command**: a deterministic per-site command added through
  promotion. Acquired site commands are generated from `catalog.json`,
  surfaced in `SKILL.md` and `manifest.json`, and should be preferred over
  fallback when they directly fit.
- **State-Scoped Skill**: an acquired site command that declares deterministic
  preconditions and, optionally, an auto-enter command that reaches those
  preconditions. Runtime enforces the preconditions before execution and
  returns `precondition_failed` when they are not met. The planner may suggest
  a chain; it does not silently execute multi-command workflows.
- **Command State Scope**: the optional `stateScope` contract on a process
  tape. Missing `stateScope` means global command. Present `stateScope`
  contains deterministic preconditions, optional postconditions, optional
  `autoEnterProcessName`, and `onUnmetPrecondition`.
- **Skill Chain Plan**: a deterministic ordered list of acquired commands that
  should be run before a target command. If the chain cannot be built,
  Cartographer recommends fallback.
- **Playwright CLI Substrate**: the browser-control layer Cartographer uses
  for fallback operation. It follows `microsoft/playwright-cli`: named browser
  sessions, accessibility snapshots, element refs, generated Playwright
  selector forms, and CLI invocations that are efficient for coding agents.
  _Avoid_: raw Playwright MCP exposed beside Cartographer, screenshot-only
  fallback, separate unrecorded browser control
- **Snapshot Ref**: a stable-for-current-snapshot element reference such as
  `e15` returned by the Playwright CLI substrate. It is convenient for agent
  interaction but must be resolved into selector diagnostics for promotion.
- **Selector Diagnostics**: the selector evidence Cartographer derives from a
  fallback target, including role/text/href candidates, stability labels, and
  warnings. Selector diagnostics are promotion evidence; raw snapshot refs are
  not durable enough for acquired commands.
- **Task Shell**: `cartographer use` / `cartographer shell`, the agent-facing
  live task cockpit that keeps domain, task id, segment intent, fallback
  recording, acquired-command routing, review, and completion in one context.
  It is not a separate browser automation surface; fallback commands still run
  through the Playwright CLI substrate and acquired commands still run through
  the runtime.
  _Avoid_: raw Playwright CLI shell, chatty semantic browser agent
- **Recorded Playwright Command**: a `cartographer pw` invocation or Task Shell
  fallback command that shells out to Playwright CLI, attaches to the
  Cartographer-owned task browser, and appends a fallback operation to the
  active segment journal.
  _Avoid_: direct `playwright-cli` calls that bypass recording
- **Task Segment**: an agent-defined browser subgoal that is executed through
  one primary surface: either a matching command or recorded Playwright CLI
  fallback.
  _Avoid_: step, whole task, arbitrary click
- **Segment File**: a local task-segment record created when no command fits
  and the agent enters a Cartographer-owned fallback session.
  _Avoid_: SQL task row, transcript-only segment
- **Task File**: a local parent record created by `begin-task`; it indexes the
  fallback-backed segment files that belong to the user task.
  _Avoid_: persisted record for every CLI-only task
- **Recording Cleanup**: an explicit destructive command that deletes local
  acquisition recordings: task files, segment files, fallback tapes, evidence,
  and promotion review artifacts.
  _Avoid_: automatic expiry, deleting acquired commands
- **Segment Event Journal**: the append-only `events.jsonl` file owned by an
  active fallback segment. It records fallback operations and same-task CLI
  calls in chronological order for review.
  _Avoid_: prompt transcript as source of truth, hidden browser state
- **CLI Context Operation**: a CLI command executed while a fallback segment is
  active for the same `taskId`. It is recorded in the segment journal as
  `surface: "cli"` and `promotionEligible: false`.
  _Avoid_: promoting an already-existing command from its own journal entry
- **Exec Command Wrapper**: `cartographer exec-command <domain> <command>`.
  It resolves generated site command names through the catalog and runs them
  without requiring the emitted site binary to be on `PATH`.
  _Avoid_: depending on shell PATH for generated site CLIs
- **Shell Acquired Command**: an acquired site command invoked inside the Task
  Shell as `exec <command> arg=value` or directly as `<command> arg=value`.
  It is syntactic sugar over the Exec Command Wrapper and is journaled as
  non-promotable CLI context when fallback is active.
  _Avoid_: promoting an existing acquired command from shell history
- **Promotion Eligibility**: the per-operation flag that tells review whether
  an event can become an acquired command. Browser fallback operations can be
  eligible; CLI context operations are not.
- **Login Wait**: a browser pause triggered when Cartographer detects an
  Instagram login screen. The human logs in through the open browser and
  presses Enter before runtime or fallback continues.
- **Site Browser Profile**: the persistent Chrome profile under
  `~/.cartographer/sites/<domain>/browser-profiles/default` used by
  Cartographer-owned browser sessions so login persists while Cartographer
  still owns the Playwright/CDP connection.
- **Contract**: the generated `SKILL.md` and `manifest.json` pair that tells an
  agent how to use the CLI.
- **Manifest**: the machine-readable command contract. It lists args, outputs,
  postconditions, write flags, and failure fields.
- **Catalog**: the generated-command source of truth, stored as
  `catalog.json`. It indexes acquired process tapes and is the input for
  regenerating the site CLI, `SKILL.md`, and `manifest.json`.
  _Avoid_: hand-edited skill list, stale command appendix
- **Process Tape**: the persisted replay plan behind a command.
- **Step**: one recorded browser operation inside a process tape.
- **Postcondition**: a deterministic final-state check that decides command
  success.
- **Output**: structured data intentionally returned by a command.
- **Drift**: diagnostic evidence that replayed page shape differed from the
  recorded shape. Drift alone is not failure.
- **Fallback**: explicit local browser recording used when no command fits or a
  command fails.
- **Cartographer-owned Fallback Session**: the controlled browser capture
  surface that Cartographer opens when no command fits; the external agent
  operates this session through Cartographer's Playwright-CLI-style base
  browser commands so the resulting tape is recordable and reviewable.
  _Avoid_: passive MCP recorder, arbitrary browser observer
- **Fallback Operation**: a deterministic event from a fallback session, such as
  `open`, `goto`, `snapshot`, `click`, `dblclick`, `hover`, `fill`, `type`,
  `press`, `eval`, `screenshot`, `record_step`, or a non-promotable CLI context
  operation.
- **Fallback Tape**: a saved fallback recording with session metadata,
  operation log, replayable steps, evidence, selectors, args, validators, and
  write flags.
- **Acquisition Packet**: the saved whole fallback artifact created when a
  fallback segment records meaningful operations. It may have zero replayable
  steps, but it still carries operation log, evidence, selectors, write flags,
  and review paths so the agent can make a typed decision.
  _Avoid_: unsaved prompt transcript, best-effort notes
- **Replayable Step**: a deterministic browser action inside a process tape.
  In the current `cartographer pw` flow, replayable steps are produced from
  approved operation slices during promotion. The agent reviews evidence; it
  does not hand-select steps through a prompt.
- **Selector Diagnostics**: deterministic selector metadata captured for review:
  selector kind, stability, reason, match count, and alternatives when
  available.
- **Selector Bundle**: the ranked selector candidates captured for one browser
  target. A bundle may include Playwright locators, CSS selectors, relative
  XPath, and the raw Playwright CLI ref. The raw ref is evidence, not a durable
  replay selector.
- **Rich Evidence Packet**: the per-operation evidence directory written by
  `cartographer pw`, containing Playwright CLI stdout, page metadata, snapshot
  YAML, deterministic summary, extracted refs, and target selector candidates
  when available.
- **Evidence Summary**: the compact `summary.json` inside a rich evidence
  packet. It is generated deterministically from page metadata, snapshot refs,
  selector candidates, and warning rules. Agents read it before full snapshots.
  _Avoid_: LLM summary, narrative recap
- **Promotion Decision**: typed JSON returned by the agent after reviewing a
  fallback. It chooses exactly one action: promote, reject, or delete.
- **Capability Duplicate**: a fallback whose browser capability is already
  covered by an existing command, even if the proposed command name differs.
  _Avoid_: duplicate name only
- **Duplicate Candidate**: an existing command surfaced by deterministic review
  because its contract overlaps a fallback's intent, postconditions, arguments,
  outputs, write flag, or browser destination.
- **Duplicate Judgment**: the agent's explicit promotion-review decision about
  whether a fallback is distinct from the surfaced duplicate candidates.
- **Promotion Policy**: deterministic code gate that validates a promotion
  decision before Cartographer writes a new command.
- **Acquisition**: promotion of a reusable fallback tape into a new command.
- **Learning Debt**: the obligation created when fallback is used. The agent
  must run end-of-task review and promote, reject, or delete reviewed fallbacks.
- **Promotion**: converting a reviewed fallback tape into a process tape,
  updating `catalog.json`, then regenerating the CLI, `SKILL.md`, and
  `manifest.json`.
- **Contract Mutation**: the deterministic write step after a policy-accepted
  promotion. Cartographer updates the catalog and regenerates visible contract
  files; agents do not manually append `SKILL.md` or `manifest.json`.
  _Avoid_: doc-only skill addition, manual command injection
- **Abandoned Segment**: a fallback segment explicitly closed without an
  acquisition packet. This is for empty/noisy/pre-auto-save segments, not for
  silently discarding meaningful fallback work.
- **No-Acquisition Completion**: an explicit task closeout for a task that
  entered fallback but saved no acquisition packet. It requires a human/agent
  reason because it may indicate external escape or unusable evidence.
- **Promotion Slice**: an agent-selected contiguous subset of replayable steps
  from a broad fallback tape that can be promoted as one reusable command while
  the original tape remains task evidence.
  _Avoid_: non-contiguous macro, full-task command by default
- **Evidence Command**: a deterministic command that gathers browser evidence
  for the agent, such as profile header text, recent post links, captions,
  screenshots, or visible counts.
  _Avoid_: semantic lead score, business judgment command
- **Textual Evidence Bias**: the acquisition rule that promoted read/evidence
  commands should prefer selector-backed textual outputs over screenshots
  whenever the target evidence is text or DOM-readable.
  _Avoid_: screenshot-first extraction
- **Mechanistic Slice Candidate**: a Cartographer-proposed contiguous step range
  derived from deterministic boundaries such as URL transitions, write
  boundaries, placeholders, evidence capture, and selector risk changes.
- **Original Tape Disposition**: the review outcome for the broad fallback tape
  after selected promotion slices are handled; unselected candidate slices do
  not need individual explanations.
- **Trash Tape**: a broad fallback tape moved by Cartographer into
  `trash_tapes` after successful slice promotion; it is a non-recoverable local
  sink, not a restoreable lifecycle state.
  _Avoid_: archive, recoverable delete
- **noLlm Mode**: the operational mode in which Cartographer constructs
  Stagehand. With `noLlm: true` and `selfHeal: false`, Stagehand initializes
  without any provider API key, and any LLM-requiring method (`act(string)`,
  `observe`, `agent`, self-heal) throws if invoked. The runtime hot path —
  `act(Action)` deterministic replay through `takeDeterministicAction` — is
  the only sanctioned use of Stagehand during a CLI command. Patched into
  fork-local Stagehand via `apply-nollm-patch.mjs`.
- **Stagehand Boundary**: the narrow Stagehand surface Cartographer relies
  on. Permitted: `init`, `act(Action)`, `page.goto`, `close`, frame/locator
  resolution, lifecycle waits. Forbidden during runtime: `act(string)`,
  `observe`, `agent`, self-heal. Policed by `noLlm Mode`.
- **Apply Script** (`apply-nollm-patch.mjs`): idempotent runner that applies
  the four-hunk `noLlm` patch to `packages/core/lib/v3/v3.ts` after a fresh
  pull. Sentinel-protected — re-running detects each hunk and skips. The
  options.ts and cartographer side of the patch are committed directly; v3.ts
  ships through this script because the file exceeds single-tool-call
  payload limits.

## Boundaries

- Agent controls tool selection.
- CLI controls command execution.
- Base browser commands control fallback exploration; acquired site commands
  control reusable deterministic site operations.
- Raw Playwright MCP should not be exposed beside Cartographer for normal
  acquisition runs because it bypasses task lifecycle, recording, and
  promotion enforcement.
- Task segments control when the agent chooses between a known command and
  fallback.
- Segment event journals keep fallback tapes replayable and reviewable while
  allowing same-task CLI commands to appear as context.
- Segment files are created for fallback/acquisition segments, not for every
  successful known CLI command.
- `cg use`/`cartographer shell` is the preferred live fallback cockpit. It
  keeps the task id, active segment intent, runtime, browser, and recorded
  Playwright CLI session hot while still writing the same fallback journal.
- `cartographer pw` owns cold one-command segment-file creation for recorded
  fallback. The first recorded Playwright command creates the segment record
  and `events.jsonl` when no active segment exists.
- A changed `cartographer pw --intent` is a segment boundary. Cartographer
  materializes the current recording segment and starts a new one for the new
  intent.
- `review-task` materializes active recorded Playwright command journals into
  fallback tapes. The packet is reviewable even if it is not promotable.
- Task files are created by `begin-task`, then used as the review index for all
  fallback-backed segments in that user task.
- Recording cleanup is explicit and preserves acquired command contracts,
  generated CLIs, process tapes, and action cache.
- Postconditions control command success.
- Fallback controls new task execution when no command fits.
- Agent reasoning controls promotion judgment through `PromotionDecision`.
- Promotion policy and code control deterministic skill mutation.
- Code surfaces duplicate candidates; agent reasoning supplies duplicate
  judgment; promotion policy enforces that the judgment is present.
- Review and promotion control organic skill growth.
- Review may use CLI context operations as evidence, but promotion must ignore
  events marked `promotionEligible:false`.
- Login wait belongs to Cartographer's browser lifecycle, not agent reasoning.
  The agent should not improvise Instagram login steps as acquired skills.
- Task-scoped Instagram work must run in a Cartographer-owned or
  Cartographer-attached browser session. Using an unrelated signed-in browser
  can complete the user task, but it cannot produce acquisition evidence.
- Promotion is the normal writer of acquired command contracts. `catalog.json`
  is updated first; the site CLI, `SKILL.md`, and `manifest.json` are
  regenerated from it.
- **Cartographer drives the show; Stagehand drives the browser.** Cartographer
  owns the graph + tape + cache + emitter + workflow layers. Stagehand owns
  the browser-driver layer (Chrome launch, CDP, Page, Locator, lifecycle
  waits). The boundary between them is `noLlm Mode`.
- **Runtime hot path requires no API key.** `act(Action)` replay,
  `page.goto`, and supporting Stagehand calls work entirely without provider
  credentials. Any code path that would have required a key throws an
  explicit error pointing back at `noLlm Mode`.

## Rules

- Do not route natural language inside Cartographer V1.
- Do not treat Playwright CLI base commands as acquired skills. They are the
  fallback substrate that generates evidence for future acquired commands.
- Do not promote snapshot refs directly. Promotion should use generated
  Playwright locators, URL postconditions, selector-backed outputs, and write
  flags.
- Do not treat hash drift as failure when postconditions pass.
- Do not silently acquire skills. Acquisition requires an explicit agent
  decision after fallback review.
- Do not silently discard fallback work. Meaningful fallback operations must
  become an acquisition packet or leave an explicit unresolved segment.
- Do not close a fallback-touched task with no acquisition packet unless the
  completion includes an explicit no-acquisition reason.
- Do not abandon meaningful write or evidence work merely to pass closeout.
- Do not manually append commands to `SKILL.md` or `manifest.json`; accepted
  promotion mutates `catalog.json` and regenerates the visible contract.
- Do not promote CLI context operations. They prove command reuse happened; they
  are not new browser skills.
- Do not acquire capability duplicates. Promotion review must compare the
  fallback against the existing command contract before adding a new command.
- Do not promote when duplicate candidates exist unless the promotion decision
  includes an explicit duplicate judgment.
- Broad fallback tapes are raw acquisition material. Promote the obvious
  reusable slices; after successful slice promotion, Cartographer moves the
  original broad tape to `trash_tapes` without asking the agent to manage
  leftovers.
- Do not ask Stagehand/model APIs for the default fallback path in V1. Default
  fallback must work locally without external API keys.
- Do not promote writes without clear write flags and `--confirm-write` runtime
  enforcement.
- Do not invoke Stagehand's `act(string)`, `observe`, or `agent` from runtime
  code paths. They will throw under `noLlm Mode`. Use `act(Action)` for
  deterministic replay; use raw Playwright for fallback recording.
- Do not require an `OPENAI_API_KEY` (or any provider key) to run a Cartographer
  CLI command. The runtime is local-first by default.
- Do not promote semantic judgments into CLI commands. Promote deterministic
  browser/evidence operations that the agent can reuse while reasoning remains
  outside Cartographer.
- Prefer textual, selector-enabled evidence outputs over screenshots.
  Screenshots are appropriate only for inherently visual evidence or as
  supplemental context.
- Do not use `pnpm build` or `pnpm typecheck` from repo root — they recurse
  into upstream `@browserbasehq/stagehand-server-v4` whose SEA build is
  broken on Node 25. Use `pnpm --filter @cartographer/core...` and
  `pnpm --filter @browserbasehq/stagehand` instead.
