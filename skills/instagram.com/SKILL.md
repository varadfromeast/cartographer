---
name: instagram-com-cli
description: Route instagram.com task segments to deterministic CLI commands first, then Cartographer fallback when no command directly fits or a command fails.
---

# instagram.com CLI Skill

Use a listed CLI command only when it directly matches the current task segment. Fallback when no listed command fits or a command returns `success:false`.

For exact args, outputs, postconditions, write flags, and failure fields, read `manifest.json` beside this file.

Do not use a separate browser, raw CDP session, standalone Playwright script, or external browser automation as acquisition fallback. Browser fallback must go through `cg use`/`cg shell` or `cg pw` so Cartographer can record evidence and enforce review.

## CLI Preflight

- `cg` should be on PATH via shell startup: `export PATH="/Users/varad/.cartographer/bin:$PATH"`. Open a new shell or source your shell rc file if `cg` is missing.
- The absolute Cartographer CLI path is `/Users/varad/.cartographer/bin/cg`.
- Doctor command: `cg doctor instagram --task-id <taskId>` reports task, generated skill, browser, CDP, and Playwright daemon state.

## Site Graph

Cartographer also compiles compact site graphs from trusted commands, fallback tapes, task evidence, and rejected review artifacts. Run `cg analyze-site instagram` to refresh the graph, then use `cg site-summary instagram`, `cg site-node instagram <node-id>`, and `cg site-actions instagram <node-id>` to inspect it.

The graph is for planning and exploration. Nodes are website surfaces; actions are directed transitions or in-place operations. Trusted CLI commands attach to actions, not nodes. Default graph output hides selectors; selectors stay in evidence and generated CLI implementations.

Rejected fallback tapes are included by default with downgraded trust. This keeps failed writes and brittle selectors visible as weak, failed, or rerecord-needed actions without hiding the underlying surface capability.

Candidate graph edges are intentionally inclusive: compose, send, follow, post, input, and destructive-looking controls remain visible with risk metadata and warnings.

## Commands

### Global Commands

| Command | Use When | Writes | Outputs |
|---|---|---:|---|
| `cg exec-command instagram open-inbox` | Open the Instagram direct messages inbox. | no | none |
| `cg exec-command instagram open-notifications` | Open the Instagram notifications panel from the current authenticated page. | no | none |
| `cg exec-command instagram open-profile-by-username` | Open an Instagram profile by username. | no | none |

### Available In Inbox

| Command | Use When | Writes | Outputs |
|---|---|---:|---|
| `cg exec-command instagram open-thread-by-name` | Search Instagram direct messages and open a matching direct-message thread or account result by visible name. | no | none |

### Available In DM Thread

| Command | Use When | Writes | Outputs |
|---|---|---:|---|
| `cg exec-command instagram send-message-current-thread` | Send a text message in the currently open Instagram direct-message thread. | yes | none |

### Other Scoped Commands

| Command | Use When | Writes | Outputs |
|---|---|---:|---|
| `cg exec-command instagram read-current-notifications-summary` | Read the visible text from the currently open Instagram notifications panel. | no | notificationRows |
| `cg exec-command instagram read-current-profile-summary` | Read the visible summary text from the currently open Instagram profile page. | no | profileText |

## Routing

- Use CLI first when one command directly fits the segment.
- For agentic live work, prefer `cg use instagram --task "<task>"`; the shell keeps task id, segment intent, one hot recorded Playwright CLI session, fallback recording, acquired-command routing, review, and complete in one context.
- For a new live task with no task ID explicitly provided by the user, start a fresh task. Do not search for, reuse, review, close, or repair an older task with similar wording.
- Treat the task ID printed by the current `cg use`/`begin-task` invocation as the only active task for that run. Ignore previous task IDs found in old review files, shell history, or summaries.
- Prefer `cg exec-command instagram <command>` for acquired commands; it resolves generated site commands without relying on PATH.
- The generated site binary also exists at `/Users/varad/.cartographer/bin/instagram-com-cli`, but `instagram-com-cli` may not be on PATH.
- When a task is active, pass `--task-id <taskId>` to every CLI command so commands reuse the task browser.
- If a login screen appears, Cartographer pauses; complete login in the open browser, then press Enter in the waiting command.
- Use `--dry-run` before write-capable commands when inspecting behavior.
- Add `--confirm-write` when a generated command requires explicit write confirmation.
- Read command JSON and prefer declared `outputs` when present.
- If a scoped command fails with `precondition_failed`, use the returned `suggestedAutoEnterProcessName`, fallback, or rerun with explicit `--auto-chain` to execute declared non-write precondition commands before retrying the target.
- If fallback is active for the same `--task-id`, a matching CLI command may still run; Cartographer journals it as non-promotable context.

## Fallback

For unfamiliar live work, start the task shell:

```bash
cg use instagram --task "<task>"
```

Inside the shell, short commands keep fallback recorded while avoiding repeated `--task-id`/`--intent`. Fallback operations reuse the same Playwright CLI attachment, so multi-step work should stay in the shell instead of spawning one `cg pw` process per micro-action:

```text
intent open inbox
snapshot
click e15
fill placeholder="Message..." "hello"
press Enter
press placeholder="Message..." Enter
review
exit
```

The shell also accepts piped scripts for deterministic smoke runs:

```bash
cg use instagram --task "<task>" <<'EOF'
complete --no-acquisition-reason "smoke only"
EOF
```

Acquired commands can also be invoked directly inside the shell with `commandName arg=value`; unknown shell commands are resolved against the acquired command catalog before failing. Use `--auto-chain` on an acquired command to run declared non-write precondition commands before retrying a scoped target.

For non-interactive fallback, create a task first:

```bash
cg begin-task instagram --intent "<task>"
```

When no command directly fits one segment and an interactive shell is not appropriate, use the recorded Playwright CLI wrapper:

```bash
cg pw instagram --task-id "<taskId>" --intent "<segment>" snapshot
```

Then continue with normal Playwright CLI commands through Cartographer:

```bash
cg pw instagram --task-id "<taskId>" goto https://www.instagram.com/direct/inbox/
cg pw instagram --task-id "<taskId>" snapshot
```

`cg pw` records automatically, but it is a cold one-command path. Prefer the shell for live multi-operation fallback because it keeps one task browser and one Playwright CLI session attached. `review-task` materializes the active operation journal into fallback tapes before creating review artifacts.

A changed `--intent` starts a new fallback segment automatically. Use specific segment intents such as `search profiles`, `inspect profile`, `open inbox`, or `send message` instead of reusing the first broad intent.

Each Playwright CLI operation writes deterministic evidence, including compact `summary.json` files. Write-adjacent operations also write `write-grounding.json` and `action-discovery.json` when selector probes can run. Read review summaries and evidence warnings before opening full snapshots.

Fallback segments write an `events.jsonl` journal. Playwright CLI fallback operations are reviewable promotion evidence; acquired site CLI events in that journal are context only (`surface:cli`, `promotionEligible:false`).

Fallback accepts the Playwright CLI command surface through the shell or `cg pw`: `open`, `attach`, `goto`, `snapshot`, `click`, `dblclick`, `fill`, `drag`, `type`, `press`, `keydown`, `keyup`, `hover`, `select`, `upload`, `check`, `uncheck`, `eval`, `dialog-accept`, `dialog-dismiss`, `resize`, `screenshot`, `pdf`, `go-back`, `go-forward`, `reload`, `mousemove`, `mousedown`, `mouseup`, `mousewheel`, `list`, `tab-list`, `tab-new`, `tab-close`, `tab-select`, `state-save`, `state-load`, `cookie-list`, `cookie-get`, `cookie-set`, `cookie-delete`, `cookie-clear`, `localstorage-list`, `localstorage-get`, `localstorage-set`, `localstorage-delete`, `localstorage-clear`, `sessionstorage-list`, `sessionstorage-get`, `sessionstorage-set`, `sessionstorage-delete`, `sessionstorage-clear`, `route`, `route-list`, `unroute`, `network-state-set`, `console`, `network`, `run-code`, `tracing-start`, `tracing-stop`, `video-start`, `video-stop`, `video-chapter`, `show`, `pause-at`, `resume`, `step-over`, `close`, `delete-data`.

Selectors may be snapshot refs, CSS, XPath, or Playwright locator forms: `e15`, `role=button[name="..."]`, `role=button[name=/.../]`, `text="..."`, `label="..."`, `placeholder="..."`, `testid="..."`.

Do not promote raw snapshot refs directly. Use selector diagnostics as evidence, then promote only reusable site actions.

Current trusted commands include `send-message-current-thread`, which is write-submit risk. If sending a message is required and the command fits the task, use it with the required write confirmation and review the rendered postcondition evidence. If fallback is used instead, record it through Cartographer and review it. Reject or rerecord write candidates that rely on raw snapshot refs instead of durable selector bundles and rendered final-state postconditions.

## Closeout

If fallback was used, create the task review:

```bash
cg review-task instagram --task-id "<taskId>"
```

Read the returned `reviewPath` first. It is compact and candidate-first. It lists the acquisition scorecard, obligations, promotion candidates, state transitions, and key selectors with links to evidence. Use fallback-level `REVIEW.md` files only for deeper inspection.

Handle acquisition obligations before rejecting whole fallback tapes. Give each handled candidate an `agentEasyToPromote` rating so weak but valuable rerecord opportunities are visible.

Review rule: a fallback tape is evidence; each proposed or custom operation slice is a candidate skill. Promote reusable safe slices independently. Reject the remaining private, noisy, transient, or task-specific slices.

Write one `review_batch` decision JSON using the returned `decisionTemplatePath` as the starting structure. One fallback may have multiple decisions when it contains multiple independent slices. Use `reviewItemId` for proposed slices, or exact `operationIndexes` for a custom slice. Use action `rerecord` for valuable candidates that need a narrow rerun with better selector probes; rerecord does not mutate the catalog.

Apply the decision:

```bash
cg apply-promotion-decision instagram --decision-file "<decision.json>"
```

Promotion applies a replay gate before mutating skills: non-write commands with no runtime args are replayed in the task browser and must satisfy postconditions. Write-capable commands are not auto-replayed because replay may send, save, delete, or publish data. If apply fails, fix the decision or reject the slice; do not manually patch the catalog.

Close only after apply succeeds:

```bash
cg complete-task instagram --task-id "<taskId>"
```

For a compact closeout check after completion:

```bash
cg task-summary instagram --task-id "<taskId>"
```

If all fallback segments were abandoned and no acquisition packet exists, close only with an explicit reason:

```bash
cg complete-task instagram --task-id "<taskId>" --no-acquisition-reason "<why no reusable evidence was saved>"
```

If any lifecycle command returns `success:false`, run the returned `command` before continuing.

## Final Report

After a live task, final response must include: `taskId`, whether fallback was used, review status, acquisition scorecard quality, promoted commands, rejected candidates, and rerecord candidates. If any item is absent, say `unknown` and name the missing artifact.
