# Cartographer Acquisition Review Plan

## Role In V1

Acquisition review is now a trust gate feeding the site graph. It is not the whole product.

Review decides whether fallback evidence becomes:

- a trusted CLI action
- an observed graph action
- weak evidence
- rerecord-required evidence
- rejected/failed evidence

Catalog mutation still happens only through `apply-promotion-decision`.

## Write Policy

Write actions are allowed to appear in graph and candidate-edge artifacts. Capture and graph construction should not hide send, compose, follow, post, input, or destructive-looking controls. They carry risk metadata and warning text so callers can decide how to execute them.

Promotion and trust still require stronger evidence than navigation:

- durable selector bundle, not raw snapshot refs
- role/name, label, placeholder, aria, contenteditable, form context, and nearby text probes where available
- stable URL/state scope
- match count that does not collide with multiple write targets
- rendered final-state postcondition
- visual review artifact for rendered final state when a confirmed write runs

For Instagram DM send, success must verify that the current thread remains open and a rendered message bubble/thread item containing `%message%` exists after submit. Text left in the composer does not count.

Candidate edges use warning-level risk:

- `none`: no write risk detected
- `possible`: may prepare or commit user-generated content
- `destructive`: may delete, block, remove, unfollow, discard, or similar

The risk warning does not remove the edge from the graph. Execution and review layers record what happened.

## Visual Review

Visual review is part of the evidence harness. It does not authorize a write before execution. It reviews the final screenshot after a confirmed write or rerecord and stores a durable verdict request beside the rest of the evidence.

The review question must be narrow:

- Does the rendered final state show the expected outcome?
- Is the expected text/result outside editable composer or input controls?
- Is there any visible failure, blocked action, login wall, or unsent draft state?

Possible verdicts are `passed`, `failed`, and `unclear`. `unclear` keeps the item in manual review. Promotion can use visual review as a supporting signal alongside DOM postconditions, trace consistency, selector grounding, and repeated successful runs.

## Rerecord

Use `rerecord` when an action is valuable but evidence is not promotion quality.

Example: `send_message_current_thread` is valuable. If the only selector is a transient snapshot ref, mark it rerecord-required. Do not promote it and do not manually add it to catalog/SKILL/manifest.

## Site Graph Impact

Rejected and rerecord decisions are still useful graph input.

They should appear as warned, weak, failed, or rerecord-needed actions with evidence refs, so future agents know:

- this action exists
- it has been attempted
- whether it is trusted
- what risk it carries
- why it may need rerecord or review

## Near-Term Improvements

1. Generate fewer duplicate action names from fallback operations.
2. Add graph queries for warned writes and rerecord candidates.
3. Use old fallback tapes as eval fixtures: graph output should expose weak writes with clear risk and trust metadata.
4. Keep promotion strict for writes; a usable graph is better than a silent or misleading command.
5. Harden implemented surface drift reconciliation with repeated live runs and stricter verifier checks.
