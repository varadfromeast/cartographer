# External Agent Handoff

Cartographer v1 is a CLI-skill layer with a browser fallback recorder. Use the
generated site CLI first. The CLI preloads the site skill registry before
execution. Use fallback recording when the generated CLI has no suitable
command, an action fails, or final postconditions fail. Drift alone is
diagnostic and is not a failure when postconditions pass.

## Start Here

Available repo-exposed skills:

- `packages/cartographer/skills/instagram.com/SKILL.md`

Runtime-local skills are also emitted to:

- `~/.cartographer/sites/instagram.com/SKILL.md`

Refresh the repo-exposed skill file after promotion review:

```bash
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js expose-skills instagram.com
```

Project tracking docs:

- `architecture.md`: current system architecture and gaps
- `agent-handoff.md`: latest operational handoff for implementation sessions
- `ubiquitous_language.md`: shared product vocabulary
- `packages/cartographer/EXTERNAL_AGENT.md`: compact guide for external agents

## Instagram v1 Flow

The external agent does the reasoning. Read `SKILL.md`, choose an explicit
command, and run it. Cartographer does not map natural-language intents to
commands in v1.

For multi-step tasks, plan task segments. Each segment uses one primary surface:
a matching CLI command, or one Cartographer-owned fallback session when no
command fits. If fallback is active for the same `--task-id`, a directly
matching CLI command may still run against the same task browser; Cartographer
journals it as non-promotable context in the segment `events.jsonl`.
For live agentic work, prefer the task shell:

```bash
cg use instagram --task "<task>"
```

The shell creates or resumes a task context, keeps `taskId` and segment intent
in memory, routes fallback commands through one hot recorded Playwright CLI
session, and routes acquired skills through one preloaded runtime. Inside the
shell, use short deterministic commands:

```text
intent open inbox
snapshot
click e15
fill placeholder="Message..." "hello"
press Enter
press placeholder="Message..." Enter
review
complete
```

Acquired skills can also be called directly inside the shell as
`commandName arg=value`. Unknown shell commands are resolved against the
acquired command catalog before failing. For scoped commands, add
`--auto-chain` to run declared non-write precondition commands before retrying
the target.

The shell also accepts piped scripts for deterministic smoke runs:

```bash
cg use instagram --task "<task>" <<'EOF'
goto /
snapshot
review
complete --no-acquisition-reason "smoke only"
EOF
```

For non-interactive use, use `begin-task` to get a stable `taskId`. Pass that
`taskId` to CLI and fallback commands, then close review with
`review-task --task-id`, `apply-promotion-decision`, and `complete-task --task-id`.
Task-scoped Cartographer browsers use the site default Cartographer profile, so
saved login should carry across tasks while actions remain recordable.
If Instagram shows a login screen, Cartographer pauses. The human completes
login in the open browser, then presses Enter in the waiting command.

Inspect available commands:

```bash
~/.cartographer/bin/instagram-com-cli --help
```

Run write-capable commands with `--dry-run` first:

```bash
cg exec-command instagram <write-command> --dry-run --key value
```

Actually write only when explicitly approved:

```bash
cg exec-command instagram <write-command> --confirm-write --key value
```

Read commands return JSON. If a command declares outputs in `SKILL.md`, consume
the `outputs` object:

```json
{
  "success": true,
  "processName": "<process_name>",
  "outputs": {
    "<outputName>": "..."
  }
}
```

## Fallback Status

Fallback is explicit and Playwright-based in v1.

If no skill fits during live work, stay inside `cartographer use`/`shell` and
run `snapshot`, `click`, `fill`, `press`, `goto`, and other Playwright
CLI-style fallback commands there. This is still the deterministic browser
fallback path; the shell calls Cartographer's recorded Playwright CLI substrate
underneath. Prefer the shell for multi-operation work because it keeps the
browser, Playwright CLI session, task id, and runtime hot.

For non-interactive one-off fallback, call `pw` directly:

```bash
node packages/cartographer/dist/cli.js pw instagram.com --task-id "<taskId>" --intent "segment description" snapshot
```

That attaches to the Cartographer-owned browser and records each Playwright
CLI-style command as fallback evidence. Continue with commands such as:

```text
goto <url>
snapshot [ref-or-selector]
click <ref-or-selector>
fill <ref-or-selector> <value>
type <text>
screenshot <label>
```

Selectors can be CSS, XPath, or Cartographer's Playwright locator forms:
`testid="..."`, `role=button[name="..."]`, `label="..."`,
`placeholder="..."`, `title="..."`, and `text="..."`. Prefer these textual
locator forms over screenshot-only evidence when the page exposes usable text
or accessibility metadata.

When a value should become a future CLI argument, use review-time
`valueBindings` in the typed decision. Do not preserve one-off literals in a
promoted command.

The saved fallback tape stores deterministic session facts:

- session id and recording timestamps
- operation log for browser commands
- same-task CLI events as non-promotable context
- operation slices proposed from the recorded command journal
- explicit screenshots/text evidence
- selector diagnostics and write flags

Review may use CLI journal events as context. Do not promote events marked
`promotionEligible:false`.

After the fallback session, finish the user task. Then run task review:

```bash
node packages/cartographer/dist/cli.js review-task instagram.com --task-id "<taskId>"
```

The command prints `reviewPath`, `reviewRequestPath`, and `fallbackReviews`.
Read task REVIEW.md first. It is compact and candidate-first. It lists
promotion candidates (slices), state transitions, and key selectors with links
to evidence. Open fallback-level review or raw evidence only when needed for
deeper inspection.

If fallback segments were abandoned and no acquisition packet was saved,
`complete-task` requires an explicit no-acquisition reason:

```bash
node packages/cartographer/dist/cli.js complete-task instagram.com --task-id "<taskId>" --no-acquisition-reason "<why no reusable evidence was saved>"
```

For lower-level inspection, list unpromoted fallback tapes:

```bash
node packages/cartographer/dist/cli.js review-fallbacks instagram.com
```

This command emits review packets and writes `REVIEW.md` files under the
fallback directory. Inspect a specific fallback and its evidence previews:

```bash
node packages/cartographer/dist/cli.js inspect-fallback instagram.com <fallback-id>
```

Normal promotion uses a typed decision. Create review artifacts:

```bash
node packages/cartographer/dist/cli.js create-promotion-review instagram.com <fallback-id>
```

Read `review-request.json`, `decision-schema.json`, `decision-template.json`,
and `REVIEW.md`. Return one flat `PromotionDecision` JSON, then let
Cartographer apply it:

```bash
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decision.json>
```

`apply-promotion-decision` owns the safety gate. Before catalog mutation it
automatically replays non-write/no-arg promotions in the task browser and
requires declared postconditions to pass. Write-capable promotions are not
auto-replayed because replay may send, save, delete, or publish data. If apply
fails on replay, reject or revise that slice instead of editing catalog files.

If `review-request.json` includes `duplicateCandidates`, promotion decisions
must include `duplicateJudgment`. Reject the fallback when an existing command
already covers the same browser capability.

After a successful promote decision, the result includes
top-level `agentContractDelta` and `reusableCommand.command`. Patch your working
command list with `agentContractDelta` immediately, then use that exact command
for future matching tasks.

Direct `promote-fallback`, `reject-fallback`, and `delete-fallback` commands
are deprecated. Mutation must go through `apply-promotion-decision` so the
typed schema, duplicate checks, operation slicing, and `stateScope` are all
preserved.

Delete all local acquisition recordings only when explicitly requested:

```bash
node packages/cartographer/dist/cli.js cleanup-recordings instagram.com --confirm-delete
```

This preserves acquired commands and generated contracts.

## How Stagehand Is Hidden

External agents do not need to call Stagehand directly.

For acquired skills, when the catalog is non-empty:

- `instagram-com-cli` loads a process tape.
- The emitted CLI preloads the site catalog and process tapes.
- The process tape replays recorded Stagehand `Action[]`.
- Cartographer validates each step with explicit validators plus its state/action cache.
- Writes require `--confirm-write`.

For missing skills:

- prefer `cg use instagram --task "<task>"`; use `cartographer pw instagram.com --task-id <taskId> --intent <segment> <command>` for one-off non-interactive fallback.
- Cartographer records deterministic browser commands automatically.
- Task review happens after the user task is complete.
- Explicit promotion turns reusable fallback tapes into new CLI commands and
  SKILL.md entries.

Stagehand remains the deterministic replay/browser integration layer for
acquired commands. The V1 acquisition fallback path is Playwright CLI based and
must work locally without external model/API keys.
