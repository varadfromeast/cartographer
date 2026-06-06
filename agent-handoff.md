# Cartographer Agent Handoff

## Current Direction

Cartographer is moving out of the Stagehand repo into a standalone repository at:

```text
/Users/varad/V/repo/cartographer
```

V1 is a compact site-graph compiler plus Playwright-backed evidence harness.

The fastest usable product is not a full live crawler or MCP server yet. It is:

1. record evidence while agents browse with `cg use`, `cg shell`, or `cg pw`
2. capture live surfaces through `explore-harness`
3. compile evidence into a compact graph with `cg analyze-site instagram.com`
4. let external agents inspect the graph and call trusted CLI actions
5. expose write actions with risk metadata and durable review evidence

## What Changed

Older docs described Cartographer as a Stagehand-backed layer inside the Stagehand fork. That is obsolete.

Current runtime:

- Playwright browser sessions
- Playwright CLI/CDP fallback adapter
- JSON evidence stores in `~/.cartographer`
- reviewed catalog commands
- generated per-site CLI and skill docs
- offline site graph compiler

Stagehand is not required for Cartographer execution.

## Key Commands

```bash
pnpm typecheck
pnpm build

node dist/cli.js analyze-site instagram.com
node dist/cli.js site-summary instagram.com
node dist/cli.js site-node instagram.com direct_thread
node dist/cli.js site-actions instagram.com direct_thread
node dist/cli.js explore-harness linkedin.com --goal linkedin_home_feed
```

Installed shortcuts, when exposed:

```bash
cg analyze-site instagram
cg site-summary instagram
cg site-node instagram direct_thread
cg site-actions instagram direct_thread
```

## Important Files

- `src/site-graph.ts`: graph compiler and markdown renderer.
- `src/cli.ts`: CLI entrypoints.
- `src/task-browser.ts`: Playwright task browser.
- `src/playwright-cli-adapter.ts`: recorded fallback execution.
- `src/write-grounding.ts`: write selector probes/scoring.
- `src/explorer/surface-capture.ts`: live surface artifact capture.
- `src/explorer/post-capture.ts`: `classifySurface`, `extractCandidateEdges`, and `recordGraphMutation`.
- `src/explorer/harness.ts`: exploration harness loop.
- `src/skill-emitter.ts`: generated external-agent contract.
- `skills/instagram.com/SKILL.md`: generated Instagram skill contract.
- `skills/instagram.com/manifest.json`: generated machine-readable contract.

Graph output paths:

```text
~/.cartographer/sites/instagram.com/site-graph.json
~/.cartographer/sites/instagram.com/site-graph.md
```

## Product Contract

The graph should be compact enough for an external agent to read quickly.

Nodes are website surfaces. Actions are state transitions or operations. Trusted CLI commands attach to actions, not nodes.

Do not put raw selectors in the default graph output. The graph may point to evidence refs; detailed selectors remain in tapes, summaries, and generated CLI code.

Include rejected tapes by default. They teach the graph which actions are weak, failed, or rerecord-needed.

## Instagram Status

Trusted commands:

- `open-inbox`
- `open-profile-by-username`
- `open-thread-by-name`
- `send-message-current-thread`

Observed lower-level surfaces and fallback evidence:

- fill message composer
- submit current composer
- search/fill profile surfaces
- assorted thread/profile controls

`send_message_current_thread` is write-submit risk. It appears in the graph and is represented honestly; runs should leave rendered postcondition evidence and visual review artifacts.

## Exploration Harness Status

Current post-capture loop:

```text
captureSurface
-> classifySurface
-> matchExistingNode
-> diffSurfaceControls
-> extractCandidateEdges
-> reconcileEdges
-> recordGraphMutation
```

LinkedIn has been verified through five live goals:

- `linkedin_home_feed`
- `linkedin_search_results`
- `linkedin_messaging`
- `linkedin_notifications`
- `linkedin_my_network`

Each goal emitted the surface capture bundle plus classification, node match, control diff, candidate edge, edge reconciliation, graph mutation, and graph candidate artifacts.

Candidate edges are inclusive: write/input/destructive-looking controls are included with `writeRisk` and warnings rather than filtered.

## Next Engineering Priorities

1. Keep improving graph compaction and action naming.
2. Add graph queries useful to agents: shortest trusted path, actions by risk, warned writes, evidence refs.
3. Use graph output in live smoke tests before adding MCP.
4. Harden drift reconciliation thresholds with more repeated live runs across LinkedIn, X, and Instagram.
5. Tighten write-action risk metadata so failed or noisy fallback operations are still visible but clearly warned.
6. Only after the local graph is useful, expose it through an MCP server or richer harness.
