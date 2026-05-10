# Agent Handoff - Cartographer V1

Cartographer is a CLI skill layer built in this Stagehand fork. The ideal V1
product shape is:

1. External agents read the generated `SKILL.md` and optional `manifest.json`.
2. For substantial or unfamiliar tasks, the agent calls `begin-task` to get a
   scoped `taskId` and required review command.
3. The agent chooses a deterministic per-site CLI command when one directly
   fits the user task.
4. The CLI executes only the named command. It does not infer broad intent.
5. Runtime replays the recorded process tape and validates final
   postconditions.
6. Command JSON returns structured execution, postcondition, drift, output, and
   failure data.
7. If no listed command fits, or a command fails, the agent uses
   `cg use` / `cartographer shell` as the preferred recorded Playwright CLI
   fallback surface, or `cartographer pw` for one-off non-interactive fallback.
8. Recorded fallback creates learning debt and requires a scoped review command.
9. After the user task is complete, fallback tapes are reviewed.
10. Reusable fallbacks are promoted into new CLI commands, regenerated
    `SKILL.md`, and regenerated `manifest.json`.

The key boundary is MCP-like: tool selection is agent-controlled, command
execution is CLI-controlled.
For multi-step work, the agent should split the task into task segments. Each
segment uses one primary surface: a known CLI command when one directly fits,
otherwise recorded Playwright CLI fallback through the task shell or
`cartographer pw`. If
fallback is active for the same `--task-id`, a directly matching acquired CLI
command may still run against the same task browser; Cartographer journals it
as non-promotable context in the segment `events.jsonl`.
Task files are created by `begin-task`. Use the `taskId` from `begin-task`,
pass it into `cartographer pw`, and close with `review-task --task-id`, then
`apply-promotion-decision`, then `complete-task --task-id`. If the agent
forgets `begin-task`, `cartographer pw` refuses to run and prints the required
`begin-task` command.

Use `ubiquitous_language.md` for shared domain vocabulary. In particular,
fallback creates learning debt: after a fallback is used, the agent must run
`review-task`, then apply a typed promotion decision that promotes, rejects, or
deletes each reviewed fallback.
Promotion review now also checks for capability duplicates. If deterministic
review surfaces duplicate candidates, the typed `PromotionDecision` must include
`duplicateJudgment`; otherwise promotion is rejected by policy.

## Current Status

Implemented package:

```text
packages/cartographer/
```

Current site:

```text
instagram.com
```

Generated agent contract files:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
~/.cartographer/sites/instagram.com/SKILL.md
~/.cartographer/sites/instagram.com/manifest.json
```

Generated local CLI:

```text
~/.cartographer/bin/instagram-com-cli
```

Current live-test target:

```text
Keep the Instagram catalog empty unless a live fallback/review/promotion run
organically acquires a command.
```

Current Instagram catalog state: zero acquired commands. Older acquired commands
from previous experiments were cleared and should not be treated as validated
product state.

### Playwright CLI substrate decision (2026-05-09)

`microsoft/playwright-cli` is now the target fallback substrate. The upstream
repo is a small package around Playwright core's CLI client/daemon:

```text
playwright-cli command
  -> named session daemon over socket
  -> Playwright MCP-style browser backend
  -> accessibility snapshot refs
  -> Playwright-style selector handling
```

Cartographer has adopted that model inside this repo for the fallback command
loop. The preferred agent-facing fallback surface is the hot task shell
(`cg use` / `cartographer shell`); `cartographer pw` remains the one-command
non-interactive fallback wrapper.

Decision:

```text
Use current repo: /Users/varad/V/repo/stagehand
Do not create a separate Cartographer repo yet.
Do not expose raw Playwright MCP beside Cartographer for acquisition runs.
Use upstream playwright-cli as the reference/base, then own Cartographer hooks.
```

Interface scaffold added:

```text
packages/cartographer/src/playwright-cli-substrate.ts
```

Base browser commands are fallback primitives:

```text
open, goto, snapshot, click, dblclick, hover, fill, type, press, eval, screenshot, run-code
```

Inspection helpers are recorded as evidence/context, not promotion candidates.
Promotion should come from reusable site actions and explicit review decisions.
Cartographer records selector diagnostics for snapshot refs; those diagnostics
are evidence for review, not a durable command contract by themselves.

Acquired site commands are still organic promotion outputs. Do not prepopulate
Instagram commands. The slicer/review/promoter should learn them from recorded
fallback usage.

### State-scoped planner status (2026-05-09)

State-scoped skills are represented as optional metadata on acquired commands:

```text
stateScope.preconditions
stateScope.autoEnterProcessName
stateScope.onUnmetPrecondition
```

The first planner surface is intentionally small:

```bash
node packages/cartographer/dist/cli.js plan instagram.com <process-name>
```

It returns a suggested command chain when declared metadata is sufficient. It
does not execute the chain. The external agent executes the returned steps or
uses fallback when `fallbackRecommended:true`.

### noLlm patch is applied (zero API key required for runtime)

Stagehand was patched fork-locally to support `noLlm: true`, which skips
LLM client construction entirely. Cartographer's `BrowserSession` now
constructs Stagehand with `selfHeal: false` and `noLlm: true`, so the
runtime hot path (`act(Action)` deterministic replay) requires no
`OPENAI_API_KEY` or any other provider credentials.

Patch is split across three commits and one applier script:

- `packages/core/lib/v3/types/public/options.ts` — adds `noLlm?: boolean`
  field to `V3Options`.
- `packages/cartographer/src/browser-session.ts` — passes `noLlm: true`
  to the Stagehand constructor.
- `apply-nollm-patch.mjs` (repo root) — idempotent script that applies
  the 4 hunks to `packages/core/lib/v3/v3.ts`. Run once after pulling.

To bring a fresh checkout to the current state:

```bash
git pull origin main
node apply-nollm-patch.mjs        # applies 4 hunks to v3.ts; safe to re-run
pnpm install
pnpm --filter @browserbasehq/stagehand build
pnpm --filter @cartographer/core build
git add packages/core/lib/v3/v3.ts
git commit -m "feat(v3): apply noLlm patch via apply-nollm-patch.mjs"
git push
```

### Live smoke verified

Most recent smoke after clearing skills verified the current fallback path:
scripted `cg use` ran a browser `goto`, generated review artifacts, exited
cleanly, applied a typed reject decision, and completed the task. The run used
the task-scoped browser profile and the recorded Playwright CLI substrate.

Current lifecycle support:

```text
begin-task persists task.json and returns taskId, fallback command, required review command
active fallback segments append operations to events.jsonl
review-task materializes recorded segment journals into fallback tapes
generated SKILL.md and manifest.json mark fallback closeout as required
task review emits review-request.json, decision-schema.json, decision-template.json, and REVIEW.md
apply-promotion-decision applies agent reasoning through deterministic code
```

Logs are enabled by default and written to stderr so JSON stdout remains
parseable. Use `CARTOGRAPHER_LOG=0` to silence logs and
`CARTOGRAPHER_LOG_LEVEL=debug` for selector/action-level detail.

Useful commands:

```bash
pnpm --filter @cartographer/core typecheck
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
node packages/cartographer/dist/cli.js expose-skills instagram.com
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

## Agent Contract

The generated `SKILL.md` is the human-readable operating contract. The generated
`manifest.json` is the machine-readable command contract.

The contract tells the agent:

- what commands exist
- which commands write to Instagram
- what arguments each command accepts
- what outputs each command declares
- what final postconditions decide command success
- how to interpret `success`, `execution`, `postconditions`, `drift`, and
  `failure`
- how to enter fallback recording
- how to review and promote fallback tapes so the CLI acquires skills
- that fallback-created learning debt must be closed before the task is
  considered complete
- that fallback promotion must explicitly address duplicate candidates before
  adding a new command

There is no hidden natural-language router in V1. The external agent decides
whether a listed command directly fits the user task.

## Success Model

Old behavior treated hash drift as command failure. That was too strict for
dynamic sites like Instagram.

Current behavior:

```text
success = no action failures && final postconditions passed
```

Hash drift is diagnostic only. A command can return `success:true` with
`drift.detected:true` if final postconditions passed.

Supported postconditions reuse `StepValidator`:

```ts
{
  type: "url_equals";
  value: string;
}
{
  type: "url_contains";
  value: string;
}
{
  type: "selector_exists";
  selector: string;
}
{
  type: "text_contains";
  selector: string;
  value: string;
}
```

Example result shape:

```json
{
  "success": true,
  "processName": "<acquired_process_name>",
  "execution": {
    "completed": true,
    "stepCount": 2,
    "executedStepCount": 2,
    "actionFailures": []
  },
  "postconditions": {
    "required": true,
    "passed": true,
    "checks": [
      {
        "type": "url_contains",
        "passed": true,
        "expected": "<postcondition>",
        "observed": "<observed browser state>"
      }
    ]
  },
  "drift": {
    "detected": false,
    "severity": "none",
    "steps": []
  },
  "outputs": {},
  "message": "Replayed step(s); postconditions passed."
}
```

## Happy Path

### 1. Agent Reads The Contract

Start from:

```text
packages/cartographer/skills/instagram.com/SKILL.md
packages/cartographer/skills/instagram.com/manifest.json
```

For substantial or unfamiliar tasks, create a task envelope:

```bash
node packages/cartographer/dist/cli.js begin-task instagram.com --intent "task description"
```

Keep the returned `taskId`. If fallback is used, pass that `taskId` to
`cartographer pw` and close the task with the returned
`requiredReviewCommand`.

The agent should choose a listed command only when it directly fits. If no
listed command fits, use fallback recording.

### 2. Agent Runs A Known CLI Skill

If the task matches an available command:

```bash
~/.cartographer/bin/instagram-com-cli <command> [args]
```

For write commands:

```bash
--confirm-write
```

For read commands, consume declared values under `outputs` when present.
Navigation-only commands can have no outputs but must still have deterministic
postconditions.

### 3. Runtime Replays And Validates

Runtime path:

```text
NodeCliEmitter output
  -> createPreloadedRuntime(domain)
  -> SkillRegistry.preload(domain)
  -> ProcessTapeRuntime.runProcess()
  -> SkillRegistry.getProcess()
  -> BrowserSessionFactory.launch(domain, options)
  -> BrowserSession.actRaw(Action) or BrowserSession.goto(url)
  -> StateIdentity.capture()
  -> ReplayValidator.validate(step.validators) for drift diagnostics
  -> ReplayValidator.validate(process.postconditions) for final success
  -> read declared ProcessOutput selectors
  -> JSON result
```

Important interfaces:

- `ProcessTape`: recorded command, args, steps, outputs, postconditions, write
  flag.
- `SkillRegistry`: preloads the site catalog and process tapes for command
  lookup.
- `TapeStore`: persists process tapes behind the registry.
- `BrowserSessionFactory`: opens the browser.
- `BrowserSession`: abstracts Stagehand/browser actions.
- `StateActionCache`: stores structural action cache entries by state/atom.
- `StateIdentity`: captures and normalizes state fingerprints.
- `ReplayValidator`: validates step expectations and final postconditions.
- `CartographerLogger`: emits live-run diagnostics to stderr.
- `CartographerRuntime`: narrow interface exposed to emitted CLIs.

### 4. Agent Uses Fallback When No Skill Fits

If no command directly fits during live agent work, prefer the hot task shell:

```bash
cg use instagram --task "<task>"
```

Inside the shell, use short commands such as `snapshot`, `click e15`,
`fill <selector> <value>`, `press Enter`, and
`exec <acquired-command> arg=value` when the catalog has acquired commands. The
shell keeps the task id, active intent, preloaded runtime, task browser, and
recorded Playwright CLI attachment alive across operations. It also accepts
piped scripts for deterministic smoke runs.

For one-off non-interactive fallback:

```bash
node packages/cartographer/dist/cli.js pw instagram.com --task-id "<taskId>" --intent "segment description" snapshot
node packages/cartographer/dist/cli.js pw instagram.com --task-id "<taskId>" click e15
```

This attaches Playwright CLI to the Cartographer-owned task browser and records
each command into the active segment journal. The agent should use normal
Playwright CLI commands through this wrapper:

```text
goto <url>
snapshot [ref-or-selector]
click <ref-or-selector>
dblclick <ref-or-selector>
hover <ref-or-selector>
fill <ref-or-selector> <value>
type <text>
press <key>
eval <js-expression-or-function> [--target <ref-or-selector>]
screenshot <label>
run-code <code>
tab-list/tab-new/tab-select/tab-close
cookie-*/localstorage-*/sessionstorage-*
route/tracing/video/console/network commands
```

Fallback creates a `FallbackTape` with deterministic session facts:

- `recordingStartedAt`
- an operation log covering every `cartographer pw` command
- Playwright CLI stdout/stderr, success/failure, URL, snapshot path, and write
  flags when available

`review-task` materializes active `pw`/shell operation journals into fallback
tapes before creating review artifacts. The reviewing agent then promotes only
mechanical, parameterized, reusable slices.

Running review is mandatory if fallback was used. `cartographer pw` owns
file-backed segment creation under
`~/.cartographer/sites/instagram.com/tasks/<task-id>/segments/<segment-id>/`.
The materialized fallback tape links back to the task and segment file, so
review can retrieve the exact files for that segment.
The segment also owns `events.jsonl`. Fallback browser operations are promotion
candidates; same-task CLI calls are recorded as context with
`surface:"cli"` and `promotionEligible:false`.

Current fallback implementation is Playwright-based because V1 does not assume
external API keys. The product path is the recorded task shell for live work
and `cartographer pw` for one-command non-interactive fallback, both backed by
the task-scoped browser session.

### 5. Agent Reviews The Fallback

After the user task is complete:

```bash
node packages/cartographer/dist/cli.js review-task instagram.com --task-id "<taskId>"
```

Lower-level inspection:

```bash
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>
```

Review produces a compact packet and `REVIEW.md` with intent, steps, selectors,
validators, deterministic summary, operation log, evidence previews, and the
typed apply-decision command.

### 6. Agent Promotes Or Rejects

Normal workflow uses typed promotion decisions. Create the review artifacts:

```bash
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
```

The agent reads `review-request.json`, `decision-schema.json`, and `REVIEW.md`,
or starts from `decision-template.json`, then returns one flat
`PromotionBatchDecision` JSON:

```json
{
  "action": "review_batch",
  "taskId": "<task-id>",
  "reasoning": "Review all fallback tapes for this task.",
  "confidence": "medium",
  "decisions": [
    {
      "action": "reject",
      "fallbackTapeId": "<fallback-id>",
      "reviewItemId": "<fallback-id>:fallback",
      "reasoning": "Task-specific fallback; do not acquire.",
      "confidence": "medium",
      "rejectReason": "not reusable"
    }
  ]
}
```

Apply that decision through deterministic code:

```bash
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

Direct `promote-fallback`, `reject-fallback`, and `delete-fallback` commands
are deprecated. Mutation must go through the typed decision file so schema
validation, duplicate review, slicing, and `stateScope` stay intact.

Promotion review should prefer deterministic browser/evidence commands that
grow from actual fallback recordings. Do not promote semantic workflow commands
such as lead scoring, prospect qualification, or broad research goals; the agent
should keep that reasoning outside Cartographer.
For read/evidence commands, prefer selector-backed textual outputs over
screenshots whenever the target evidence is text or DOM-readable. Use
screenshots only for inherently visual evidence or as supplemental context.

Reject or delete non-reusable fallbacks by writing a `reject` or `delete`
decision JSON and applying it with `apply-promotion-decision`.

Clean all local acquisition recordings explicitly when they are no longer
needed:

```bash
node packages/cartographer/dist/cli.js cleanup-recordings instagram.com --confirm-delete
```

This deletes task/segment files, fallback tapes, evidence, and promotion review
artifacts. It does not delete promoted commands, process tapes, generated
contracts, emitted CLIs, or the state-action cache.

Promotion writes a new `ProcessTape`, regenerates the CLI, regenerates
`SKILL.md`, regenerates `manifest.json`, and marks the fallback as promoted.
`PromotionPolicy` gates the mutation before any process is written.
The apply result includes a top-level `agentContractDelta`, plus
`cliCommandName` and `reusableCommand.command`. A long-running agent should
treat `agentContractDelta` as an immediate patch to its working command list and
use that command for future matching tasks instead of falling back again.
The regenerated CLI also supports `instagram-com-cli --help` and
`instagram-com-cli <command> --help` with descriptions, args, outputs,
postconditions, and write flags.

## Current Interfaces

Core contracts live in:

```text
packages/cartographer/src/contracts.ts
```

Main interfaces:

- `CartographerRuntime`: run a named process.
- `RunProcessResult`: structured command result with execution,
  postconditions, drift, failure, outputs, and message.
- `ProcessTape`: persisted command contract.
- `Postcondition`: final success criteria, currently an alias of
  `StepValidator`.
- `FallbackOperation`: deterministic event recorded during fallback capture.
- `FallbackPromotionSummary`: deterministic review summary created from a
  fallback tape and evidence previews.
- `PromotionDecision`: typed agent reasoning output for promote/reject/delete.
- `PromotionDecisionApplier`: validates and applies the typed decision.
- `PromotionPolicy`: deterministic promotion gate.
- `Learning Debt`: obligation created by fallback use; closed by promotion,
  rejection, or deletion after review.
- `SkillRegistry`: preload and serve a site's process catalog in memory.
- `TapeStore`: load/save process tapes and catalogs.
- `BrowserSessionFactory`: create browser sessions.
- `BrowserSession`: navigate, act, read, screenshot, validate selectors.
- `StateIdentity`: capture a normalized state fingerprint.
- `StateActionCache`: structural state/atom action cache.
- `ReplayValidator`: validate URLs, selectors, and text.
- `PlaywrightCliSubstrate`: execute Playwright-CLI-style browser commands.
- `PlaywrightCliRecordingSink`: append browser fallback operations to the task
  segment journal.
- `SegmentJournal`: store `events.jsonl` for task-scoped fallback and CLI
  context.
- `FallbackTapeStore`: save, reject, delete, and mark fallback tapes.
- `FallbackReviewer`: produce review packets.
- `TaskReview`: materialize task fallback evidence and batch review artifacts.
- `PromotionDecisionApplier`: validate typed decisions and mutate the catalog.
- `SkillPromoter`: turn reviewed fallback tapes into process tapes.
- `EndOfTaskReviewer`: read-only task closeout guard that reports unresolved
  acquisition debt.
- `CliEmitter`: emit the per-site CLI.
- `emitSkillMd` and `emitSkillManifest`: emit agent contracts.

## Stagehand Boundary

Cartographer uses Stagehand in a deliberately narrow mode: `noLlm: true`
and `selfHeal: false`. The runtime hot path makes zero LLM calls and
requires zero API keys.

Stagehand methods cartographer actually invokes:

- `new Stagehand({...noLlm:true, selfHeal:false...})` + `init()`
- `stagehand.context.pages()[0]`
- `stagehand.act(action, {variables})` — `Action` overload, deterministic
  via `takeDeterministicAction`. No LLM.
- `page.goto(url)` (via Stagehand's understudy Page) for `navigate` steps
- `stagehand.close()`

Stagehand methods cartographer does **not** call on the runtime hot path:

- `stagehand.act("click ...")` (string instruction) — would resolve via
  LLM. Throws in `noLlm` mode.
- `stagehand.observe(...)` — would resolve via LLM. Throws in `noLlm`
  mode.
- `stagehand.agent(...)` — autonomous CUA loop. Throws in `noLlm` mode.
- Self-heal — disabled at config; the throw inside `resolveLlmClient` is
  the safety net.

What Stagehand provides for free, beyond raw Playwright:

- Chrome launch + CDP attach + persistent profile (`userDataDir +
preserveUserDataDir: true` is what keeps the IG session alive)
- Iframe-aware XPath traversal (`resolveLocatorWithHops` — supports
  `>>` hop notation and deep XPath crossing iframe boundaries)
- CDP-backed `Locator` with shadow-DOM piercing
- `performUnderstudyMethod` dispatcher for click/fill/type/press/scroll/
  hover/selectOption
- `lifecycleWatcher` + `networkManager` for "page settled" detection

Stagehand cache (`ActCache`, `AgentCache`) is instruction-keyed and
**unused by cartographer**. Cartographer cache is structural:

```text
(state_id, atom_id) -> Stagehand-shaped Action[]
```

Raw Playwright fallback does not populate Stagehand's own cache. It
records cartographer fallback tapes. Promotion turns those tapes into
deterministic cartographer skills. The default fallback capture path stays
local and API-key-free; the default replay path stays local and
API-key-free.

## Verification Commands

Use scoped pnpm filters. Avoid bare `pnpm build` and `pnpm typecheck` —
they recurse into `@browserbasehq/stagehand-server-v4` whose `build:sea:esm`
step is currently broken on Node 25 (`Could not find the sentinel
NODE_SEA_FUSE_*`). The server packages are upstream-only and unrelated to
cartographer.

```bash
# typecheck only what cartographer depends on
pnpm --filter @browserbasehq/stagehand typecheck
pnpm --filter @cartographer/core typecheck

# build only the dependency chain cartographer needs
pnpm --filter @cartographer/core... build

# refresh the agent contract + emit the per-site CLI
node packages/cartographer/dist/cli.js expose-skills instagram.com

# smoke the current fallback path
printf '%s\n' 'goto /direct/inbox/' 'review' 'exit' \
  | node packages/cartographer/dist/cli.js use instagram --task "browser smoke" --intent "open inbox"
```

## Current Gaps

- **No acquired Instagram commands are currently trusted.** The catalog is
  intentionally empty after cleanup. First-class commands should be reacquired
  only through fallback, review, and `apply-promotion-decision`.
- Task-scoped browser lifecycle is implemented for commands that pass
  `--task-id`; the browser uses the site default Cartographer profile and
  closes on `complete-task`. Stateless commands use the same site profile but
  close their own browser context.
- Login wait/pause behavior is implemented for runtime and fallback browser
  paths. If Instagram shows a login screen, Cartographer waits for the human to
  log in and press Enter in the waiting command.
- `complete-task` now refuses fallback-touched tasks that saved no acquisition
  packet unless the caller passes `--no-acquisition-reason <reason>`.
- Real read skills (`view_profile`, `list_recent_posts`) should declare
  structured `outputs` in the typed promotion decision.
- Selector generation is deterministic but young.
- Existing old fallback tapes may not have operation logs or selector
  diagnostics. New Playwright fallback tapes do.
- Text evidence is explicit. If the operator does not run `text`, review
  will flag `no_text_evidence`.
- There is no MCP emitter yet.
- There is no visual sitemap/graph viewer yet.

### Resolved gaps

- ✅ **Login persistence.** Stagehand's
  `localBrowserLaunchOptions.userDataDir + preserveUserDataDir: true` keeps
  IG session cookies between CLI runs. Verified in 2026-05-03 smoke.
- ✅ **API key requirement.** With `noLlm: true`, Stagehand initializes
  without any provider credentials. Runtime hot path makes zero LLM calls.
  Verified in 2026-05-03 smoke.

## What Not To Do

- Do not add hidden intent routing or fuzzy command matching inside
  Cartographer V1.
- Do not treat hash drift as command failure when final postconditions pass.
- Do not silently promote fallback tapes.
- Do not infer read outputs magically from evidence. Promotion decisions should
  declare outputs explicitly in JSON.
- Do not modify `packages/core/` unless there is a specific Stagehand
  integration reason.
- Do not treat write actions as normal reads. Writes require `--confirm-write`.

## Caution

Cartographer drives a real browser against real accounts. Treat writes as
high-risk. Keep fallback/promotion explicit, keep write confirmation mandatory,
and prefer read-only skills until the command contract is clear.
