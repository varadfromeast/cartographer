# Cartographer Architecture

Cartographer V1 is a contract-first browser skill acquisition layer. It gives
agents a small, deterministic CLI surface for browser work, records fallback
evidence when no acquired command fits, and grows the command catalog only
through typed review decisions.

Current state:

- Site: `instagram.com`
- Acquired Instagram commands: none
- Live fallback: `cg use instagram --task "<task>"`
- One-off fallback: `cg pw instagram --task-id <taskId> --intent "<segment>" <command>`
- Review path: `review-task --task-id <taskId>`
- Only catalog mutation path: `apply-promotion-decision`
- Runtime site config: `packages/cartographer/src/sites/<domain>/config.ts`

For operational instructions, read:

- `packages/cartographer/skills/instagram.com/SKILL.md`
- `packages/cartographer/EXTERNAL_AGENT.md`
- `agent-handoff.md`
- `ubiquitous_language.md`

## Core Loop

```text
agent reads SKILL.md / manifest.json
  -> agent starts a task envelope for unfamiliar or substantial work
  -> agent runs an acquired CLI command if one directly fits
  -> command runtime validates preconditions, actions, and postconditions
  -> JSON result returns to agent

if no acquired command fits:
  -> agent uses the Cartographer task shell or cg pw fallback
  -> fallback operations are recorded into task segments
  -> user task is completed first
  -> review-task materializes fallback evidence
  -> agent writes a typed PromotionBatchDecision
  -> apply-promotion-decision promotes, rejects, or deletes deterministically
  -> generated CLI, SKILL.md, and manifest.json are refreshed
  -> complete-task closes the task/browser lease
```

The external agent controls goal reasoning, tool selection, and promotion
judgment. Cartographer controls deterministic execution, evidence storage,
postcondition validation, and catalog mutation.

## CLI Surfaces

The unified CLI shape is:

```bash
cg use instagram --task "<task>"
cg shell instagram --task-id <taskId> [--intent <segment>]
cg exec-command instagram <acquired-command> --task-id <taskId>
cg pw instagram --task-id <taskId> --intent "<segment>" <playwright-cli-command>
cg review-task instagram --task-id <taskId>
cg apply-promotion-decision instagram --decision-file <decision.json>
cg complete-task instagram --task-id <taskId>
```

`cg use` is the preferred live agent surface. It keeps task id, segment intent,
the task browser, a preloaded runtime, and one recorded Playwright CLI session
hot across operations. It also accepts piped scripts for smoke tests.

`cg pw` is the cold one-command fallback wrapper. Use it for non-interactive
fallback only.

## Fallback Substrate

Fallback is Playwright CLI based. Cartographer shells out to `playwright-cli`
against a Cartographer-owned task browser and records each operation in the
active segment journal.

Base browser commands are not acquired site skills. They are substrate
operations that produce evidence for future acquired skills. Examples include:

```text
goto, snapshot, click, dblclick, hover, fill, type, press, eval, screenshot,
run-code, tab-*, cookie-*, localstorage-*, sessionstorage-*, network, console
```

Fallback evidence includes:

- command, args, stdout, stderr, success/failure
- URL before/after
- compact `summary.json`
- raw snapshot when available
- extracted refs and selector diagnostics
- write-risk classification

The task shell prints compact summaries. Raw YAML remains linked evidence, not
the default agent context.

## Task Lifecycle

Tasks and segments are file-backed under:

```text
~/.cartographer/sites/<domain>/tasks/<taskId>/
```

Segments represent fallback/acquisition work, not every successful acquired
command. A changed segment intent creates a segment boundary. Active segment
journals are materialized by `review-task`.

Fallback creates learning debt. A task that used fallback cannot be closed
until either:

- fallback tapes are reviewed and decisions are applied, or
- all fallback segments are abandoned and `complete-task` receives an explicit
  `--no-acquisition-reason`.

`complete-task` releases the task browser lease.

## Promotion Boundary

`apply-promotion-decision` is the only catalog mutation path.

Promotion decisions are typed JSON. A task review produces:

```text
REVIEW.md
review-request.json
decision-schema.json
decision-template.json
```

The reviewing agent decides whether a fallback slice is reusable. Cartographer
validates the decision, applies policy, performs replay gates when safe, writes
`catalog.json`, and regenerates the CLI and skill contract.

Direct promotion/rejection/deletion commands are deprecated. Manual edits to
`catalog.json`, `SKILL.md`, or `manifest.json` are not valid acquisition.

## Acquired Commands

An acquired command is a deterministic process tape promoted from fallback
evidence. It may declare:

- args
- outputs
- write flag
- postconditions
- optional `stateScope`

Runtime success is:

```text
success = no action failures && final postconditions passed
```

Hash drift is diagnostic. Drift alone does not fail a command when final
postconditions pass.

State-scoped commands can declare preconditions and an optional
`autoEnterProcessName`. Cartographer only runs a precondition chain when the
caller explicitly passes `--auto-chain`, and it refuses to chain through
write-capable commands.

## Browser Runtime

Runtime browser sessions are site-agnostic through:

```ts
BrowserSessionFactory.launch(domain, options);
```

Site config lives under:

```text
packages/cartographer/src/sites/<domain>/config.ts
```

The Instagram runtime uses the site default Cartographer profile so login can
persist across tasks while browser work remains recordable.

Known acquired commands replay deterministic Stagehand-shaped actions through
`BrowserSession.actRaw(action)`. Runtime is configured for deterministic replay:
no hidden semantic self-healing, and no provider API key required on the hot
path.

## Storage

Primary local state:

```text
~/.cartographer/sites/<domain>/catalog.json
~/.cartographer/sites/<domain>/tapes/
~/.cartographer/sites/<domain>/tasks/
~/.cartographer/sites/<domain>/fallbacks/
~/.cartographer/sites/<domain>/browser-profiles/default/
packages/cartographer/skills/<domain>/SKILL.md
packages/cartographer/skills/<domain>/manifest.json
```

`catalog.json` is the source of truth for visible acquired commands. Generated
contracts are derived from it.

## Current Gaps

- Instagram has no trusted acquired commands after cleanup.
- First real read skills should declare structured outputs.
- Write skills should be promoted only with scoped postconditions that verify
  rendered final state, not text merely appearing in an input.
- Selector diagnostics are useful but still young.
- There is no FSM graph planner yet.
- There is no MCP emitter yet.
- There is no visual sitemap/graph viewer yet.

## Non-Goals

- No hidden natural-language router inside Cartographer V1.
- No raw external browser automation for acquisition evidence.
- No manual catalog mutation outside `apply-promotion-decision`.
- No semantic workflow commands such as lead scoring or broad research goals.
- No automatic write replay during promotion.
