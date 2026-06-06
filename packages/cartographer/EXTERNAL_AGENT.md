# Cartographer External Agent Contract

Cartographer gives agents a compact site graph and a deterministic CLI command surface.

It is not a hidden autonomous browser agent. Agents still decide what to do. Cartographer provides:

- trusted commands for reviewed actions
- a graph for planning
- surface artifacts for live exploration
- recorded fallback when no trusted action fits
- review gates before catalog mutation

## Start Here

For Instagram, read:

```text
skills/instagram.com/SKILL.md
skills/instagram.com/manifest.json
~/.cartographer/sites/instagram.com/site-graph.md
```

Refresh graph first when evidence may have changed:

```bash
cg analyze-site instagram
cg site-summary instagram
```

## How To Use The Graph

- Nodes are website surfaces.
- Actions are transitions or operations from a surface.
- Trusted CLI commands attach to actions.
- Selectors are hidden from the graph and live in evidence/CLI implementation.
- Rejected tapes appear as weak, failed, or rerecord-needed actions.

For V1, trusted CLI actions are directly executable from the graph. Write-capable actions are not hidden; they carry risk metadata and warning text. Execution should leave rendered postcondition evidence and review artifacts where applicable.

For exploration runs, read `agent-contract.json` first when it exists. It points to:

- `graph-candidate.json` for raw captured nodes and candidate edges
- `graph-topology.json` for resolved target status and reachability
- `verification.json` for artifact and graph-quality checks
- `graph.html` for a local visual inspection of graph shape
- safe navigation chain candidates and write-risk actions

Create or refresh these artifacts with:

```bash
cg verify-exploration-run ycombinator.com latest --write
cg exploration-visualize ycombinator.com latest
cg exploration-agent-contract ycombinator.com latest
```

## Routing

1. Use a trusted CLI command when it directly matches the segment.
2. Use the graph to understand current surface and likely next actions.
3. Use fallback only when no trusted command fits or a trusted command fails.
4. If fallback was used, run review before completing the task.

Common commands:

```bash
cg exec-command instagram open-inbox --task-id <taskId>
cg exec-command instagram open-thread-by-name --task-id <taskId> --threadName "<name>" --auto-chain
cg pw instagram --task-id <taskId> --intent "<segment>" snapshot
cg review-task instagram --task-id <taskId>
cg complete-task instagram --task-id <taskId>
```

## Fallback Rules

Fallback must go through `cg use`, `cg shell`, or `cg pw`.

Do not use raw CDP, standalone Playwright scripts, or a separate browser as acquisition fallback. Those may solve a one-off task, but they do not produce Cartographer evidence.

If a selector fails, retry inside the same task browser with a better selector. Failed selector evidence is useful, but it should not be marked as a successful operation.

## Write Rules

Write and submit actions are allowed when the command or task explicitly calls for them. Treat risk metadata as a warning, not as a graph filter.

For Instagram today, `send_message_current_thread` is a write-submit command. If used, verify rendered final state and leave review evidence. If fallback is used instead, keep it recorded through Cartographer and do not manually promote selectors outside the review flow.

## Exploration Harness

The live exploration harness currently runs:

```text
captureSurface
-> classifySurface
-> matchExistingNode
-> diffSurfaceControls
-> extractCandidateEdges
-> reconcileEdges
-> recordGraphMutation
```

`candidate-edges.json` is intentionally inclusive. It includes navigation, input, compose, send, follow, post, and destructive-looking controls with `writeRisk` and warnings instead of hiding them.

After a run, use resolved topology for planning:

```bash
cg exploration-topology ycombinator.com latest --write
cg exploration-path ycombinator.com yc_home yc_jobs latest
cg exploration-chain ycombinator.com latest node:yc_home action:<edge-id> --profile default
```

LinkedIn exploration is supported only through `explore-harness` for now:

```bash
node dist/cli.js explore-harness linkedin.com --goal linkedin_home_feed
```

The older Instagram task/skill commands remain Instagram-scoped.

## Final Report

After live work, include:

- `taskId`
- whether fallback was used
- review status
- acquisition scorecard quality
- promoted commands
- rejected candidates
- rerecord candidates

Use `unknown` only when the artifact is genuinely unavailable.
