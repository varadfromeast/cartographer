# Cartographer Live Testing Plan

This plan validates the current Cartographer V1 loop against a real browser
run. The Instagram acquired skill catalog is intentionally empty at the start of
this plan.

## Scope

Validate:

- `cg use instagram --task "<task>"` creates a task envelope.
- the task shell accepts piped/scripted commands and exits cleanly.
- fallback commands run through the recorded Playwright CLI substrate.
- fallback creates file-backed task, segment, evidence, and review artifacts.
- `review-task --task-id` scopes review to the task file.
- `apply-promotion-decision` is the only mutation path for promotion/rejection.
- `complete-task` closes the task and releases the task browser lease.

Do not assume any acquired Instagram commands exist. If a command is acquired
during testing, it must come from fallback evidence and a typed decision.

## Preflight

Run:

```bash
pnpm --filter @cartographer/core typecheck
pnpm --filter @cartographer/core build
node packages/cartographer/dist/cli.js expose-skills instagram.com
node -e "const fs=require('fs'); const p=process.env.HOME+'/.cartographer/sites/instagram.com/catalog.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); console.log(Object.keys(j.processes||{}))"
```

Expected:

- typecheck passes.
- build passes.
- repo-exposed `SKILL.md` and `manifest.json` regenerate.
- printed command list is `[]` unless a test intentionally acquired a command.

## Test 1: Scripted Shell Lifecycle

Run:

```bash
printf '%s\n' 'complete --no-acquisition-reason "scripted exit smoke"' \
  | node packages/cartographer/dist/cli.js use instagram --task "scripted shell exit smoke" --intent "no browser ops"
```

Expected:

- command exits without hanging.
- output includes `success:true`.
- task status is `closed`.

## Test 2: Browser Fallback Records Evidence

Run:

```bash
printf '%s\n' 'goto /direct/inbox/' 'review' 'exit' \
  | node packages/cartographer/dist/cli.js use instagram --task "browser fallback smoke" --intent "open inbox"
```

Expected:

- shell reports `mode:"scripted"`.
- `goto` succeeds and prints a compact evidence summary path.
- review output includes `reviewPath`, `reviewRequestPath`,
  `decisionSchemaPath`, `decisionTemplatePath`, and `fallbackReviews`.
- command exits without hanging.

## Test 3: Apply Decision

Use the returned `decisionTemplatePath` from Test 2:

```bash
node packages/cartographer/dist/cli.js apply-promotion-decision instagram.com --decision-file <decisionTemplatePath>
```

Expected:

- duplicate/noisy fallback slices are rejected, or promotion succeeds only when
  the typed decision explicitly promotes a reusable slice.
- catalog mutation, if any, happens only through `apply-promotion-decision`.

## Test 4: Complete Task

Run:

```bash
node packages/cartographer/dist/cli.js complete-task instagram.com --task-id <taskId>
```

Expected:

- task status becomes `closed`.
- browser lease is released.
- if no fallback tape was saved, command requires
  `--no-acquisition-reason <reason>`.

## Test 5: Optional Live Write

Only run this when explicitly approved. Stay inside `cg use`; do not use raw
Playwright scripts or external browsers for acquisition evidence.

Example shape:

```text
goto /direct/t/<thread-id>/
intent send test message
fill placeholder="Message..." "cartographer smoke <timestamp>"
press Enter
snapshot
review
exit
```

Expected:

- write fallback records `writesToPlatform:true`.
- review can reject the one-off write or promote only a properly parameterized,
  reusable command with explicit postconditions.

## Stop Conditions

Stop and inspect before promotion if:

- shell process hangs after `exit`.
- fallback segment files are missing or not linked from task files.
- `review-task --task-id` includes unrelated fallback tapes.
- unsupported commands are listed as Playwright fallback commands.
- a promote decision succeeds without passing schema and policy checks.
- cleanup removes acquired process tapes or generated command contracts.
