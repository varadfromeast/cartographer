# Cartographer Live Testing Plan

## Goal

Live tests should prove whether an external agent can use the graph, surface artifacts, and trusted CLI commands before falling back to recorded Playwright browsing.

The purpose is no longer “force every task into promotion.” Promotion remains useful, but V1 product value comes from making the site graph accurate, compact, actionable, and honest about write-capable surfaces.

## Smoke Loop

1. Refresh generated code and contracts.

```bash
pnpm build
node dist/cli.js expose-skills instagram.com
```

2. Compile the graph from current evidence.

```bash
node dist/cli.js analyze-site instagram.com
node dist/cli.js site-summary instagram.com
```

3. Give an external agent only:

- `skills/instagram.com/SKILL.md`
- `~/.cartographer/sites/instagram.com/site-graph.md`

4. Ask it to solve a small Instagram task.

5. Observe whether it:

- uses trusted CLI actions first
- understands write-risk warnings
- falls back through `cg use`, `cg shell`, or `cg pw`
- avoids raw CDP/standalone scripts
- closes with review when fallback was used

## Pass Criteria

- The graph is understandable without raw tape spelunking.
- Trusted navigation actions are discoverable.
- Write-capable actions are visible with risk metadata instead of hidden.
- Fallback evidence is created when the graph lacks a trusted action.
- Review does not promote brittle write selectors.

## Current Instagram Expected Result

The DM workflow should be shown as partial:

```text
open_inbox -> open_thread_by_name -> send_message_current_thread
```

All three actions are visible in the graph. `send_message_current_thread` is write-submit risk and must leave rendered postcondition evidence and visual review artifacts when executed.

If a live task requires sending a message and the trusted command fits, the agent may use it. If it falls back instead, it must leave evidence. The graph should expose the write edge either way, with warning risk metadata.

## Exploration Harness Loop

The live exploration harness currently supports:

```text
captureSurface
-> classifySurface
-> matchExistingNode
-> diffSurfaceControls
-> extractCandidateEdges
-> reconcileEdges
-> recordGraphMutation
```

For LinkedIn this was verified across five live goals:

- `linkedin_home_feed`
- `linkedin_search_results`
- `linkedin_messaging`
- `linkedin_notifications`
- `linkedin_my_network`

Each run emitted `surface.json`, `surface.md`, `stripped.html`, `aria-snapshot.yml`, `ax-tree.json`, screenshots, `classification.json`, `candidate-edges.json`, `graph-mutation.json`, and `graph-candidate.json`.

Next Instagram live harness goals:

- `instagram_home_feed`
- `instagram_search`
- `instagram_notifications`
- `instagram_dm_inbox`
- `instagram_dm_composer`

## X Harness Live Evidence

X (`x.com`) now has a saved authenticated `default` browser profile.

Session checks:

```bash
node dist/cli.js session-status x.com --goal x_home
node dist/cli.js session-status x.com --goal x_notifications
node dist/cli.js session-status x.com --goal x_messages
```

All currently report `authenticated: true` with `auth_token`, `ct0`, and `twid` cookie names present.

Recent verified X roots:

```bash
node dist/cli.js explore-harness x.com --goal x_home --max-depth 1
node dist/cli.js explore-harness x.com --goal x_messages --max-depth 1
node dist/cli.js explore-harness x.com --goal x_notifications --max-depth 1
node dist/cli.js explore-harness x.com --goal x_explore --max-depth 1 --profile default
```

Run artifacts:

```text
~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-38-56-003z/run.json
~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-39-56-563z/run.json
~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-05-23-392z/run.json
~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t18-20-52-089z/run.json
```

Observed graph candidates:

- 7 nodes: `x_notifications`, `x_home`, `x_explore`, `x_profile`, `x_messages`, `x_grok`, `x_bookmarks`
- 122 candidate edges
- 7 write-risk candidate edges, all retained with warning metadata
- per-surface artifacts now include `node-match.json`, `control-diff.json`, and `edge-reconciliation.json`
- verifier result for `x_home`: `ok: true`, 7 captures, 7 graph nodes, 122 graph edges, 0 missing artifacts, 0 mismatches
- verifier result for `x_messages`: `ok: true`, 8 captures, 7 graph nodes, 122 graph edges, 0 missing artifacts, 0 mismatches
- verifier result for profile-aware locked `x_explore`: `ok: true`, 7 captures, 7 graph nodes, 122 graph edges, 0 missing artifacts, 0 mismatches
- `x_messages` currently redirects to `x.com/i/chat/pin/recovery`, which is classified as the messages surface because it gates the messages route

The run summary now exposes the main artifact paths directly:

- `classificationPath`
- `nodeMatchPath`
- `controlDiffPath`
- `candidateEdgesPath`
- `edgeReconciliationPath`
- `graphMutationPath`

Verifier command:

```bash
node dist/cli.js verify-exploration-run x.com latest
node dist/cli.js verify-exploration-run x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-38-56-003z
node dist/cli.js verify-exploration-run x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-39-56-563z
node dist/cli.js verify-exploration-run x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-05-23-392z
node dist/cli.js verify-exploration-run x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t18-20-52-089z
```

Graph summary command:

```bash
node dist/cli.js exploration-summary x.com latest
node dist/cli.js exploration-summary x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-39-56-563z
node dist/cli.js exploration-summary x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-15-50-352z
```

Additional verified X root:

```bash
node dist/cli.js explore-harness x.com --goal x_explore --max-depth 1
node dist/cli.js verify-exploration-run x.com ~/.cartographer/sites/x.com/exploration-runs/explore-2026-05-29t17-15-50-352z
```

This run also emitted 7 captures, 7 graph nodes, 122 graph edges, 7 write-risk edges, and clean reconciliation totals.

## Profile Lock Evidence

`HarnessRunConfig.profile` is now honored by `explore-harness`, `session-status`, and the task-browser close path. Live browser-profile access is serialized per domain/profile with `withBrowserProfileLock`.

Browser sessions also now use timestamped task leases:

- `browser-session.json` stores `activeTaskLeases` with task id, owner PID, and update time
- `session-status` normalizes legacy records and prunes stale leases
- `explore-harness` removes its lease after a run but intentionally keeps the saved browser open for fast reuse
- current X and LinkedIn saved profiles show `activeTaskIds: []` and `activeTaskLeaseCount: 0` while remaining authenticated

The failure that prompted this was two parallel `session-status` commands against the same profile aborting each other's `page.goto`. After adding the lock, the same parallel shape completed cleanly:

```bash
node dist/cli.js session-status x.com --goal x_home --profile default
node dist/cli.js session-status x.com --goal x_messages --profile default
node dist/cli.js session-status linkedin.com --goal linkedin_home_feed --profile default
node dist/cli.js session-status linkedin.com --goal linkedin_messaging --profile default
```

Observed results:

- both X commands completed with `authenticated: true`
- pre-login LinkedIn checks completed without navigation aborts and correctly reported `authenticated: false`, `loginLike: true`
- after manual login, LinkedIn checks for feed, messaging, and notifications completed with `authenticated: true`
- the locked X `x_explore` crawl verified with 7 nodes, 122 graph edges, and clean reconciliation totals
- the post-lease-cleanup X `x_home` crawl verified with 7 nodes, 122 graph edges, 0 active leases after close, and the saved browser still reachable over CDP

## Reuse Checks

Open-source tools considered for harness functions:

- Session persistence: Playwright auth guidance supports storing authenticated browser state on disk: https://playwright.dev/docs/auth. Cartographer currently uses persistent browser profiles because CDP reuse and manual login gates are core to the local harness.
- Browser-profile locking: `proper-lockfile` provides cross-process lockfiles using an atomic `mkdir` strategy: https://www.npmjs.com/package/proper-lockfile. Cartographer uses it for per-domain/profile browser access because multiple CLI processes can otherwise drive the same CDP page at once.
- Lease cleanup: Node supports using signal `0` with `process.kill` to test process existence: https://nodejs.org/download/release/v5.0.0/docs/api/process.html. Cartographer uses that local primitive to prune browser task leases whose owner process has exited.
- Crawler orchestration: Crawlee has `PlaywrightCrawler` and request queue support: https://crawlee.dev/js/api/3.15/playwright-crawler. Cartographer keeps a smaller custom loop for now because each crawl step must emit surface, graph, reconciliation, and review artifacts.
- Schema validation: Zod is a good candidate for future external artifact validation: https://zod.dev/. The current verifier is custom because it checks cross-file graph invariants, not only object shapes.
- Graph algorithms: graphology is a strong future candidate for graph algorithms once graph-candidate artifacts stabilize: https://graphology.github.io/. Current graph checks are direct invariants over Cartographer's compact graph model.

## LinkedIn Harness Live Evidence

LinkedIn now has a saved authenticated `default` browser profile and live CDP record.

Current check:

- `session-status linkedin.com --goal linkedin_home_feed --profile default` reports `authenticated: true`
- auth cookie names include `li_at`, `liap`, `JSESSIONID`, `bcookie`, `bscookie`, and `lidc`
- the saved profile URL is `https://www.linkedin.com/feed/`

Session command:

```bash
node dist/cli.js session-status linkedin.com --goal linkedin_home_feed
node dist/cli.js session-status linkedin.com --goal linkedin_home_feed --leave-open
```

The `--leave-open` form remains useful if the session expires. It leaves the saved browser profile on the LinkedIn login screen so login can be completed manually.

Authenticated crawler runs:

```bash
node dist/cli.js explore-harness linkedin.com --goal linkedin_home_feed --max-depth 1
node dist/cli.js explore-harness linkedin.com --goal linkedin_messaging --max-depth 1
node dist/cli.js explore-harness linkedin.com --goal linkedin_notifications --max-depth 1
```

Fresh verified run artifacts:

```text
~/.cartographer/sites/linkedin.com/exploration-runs/explore-2026-05-29t18-32-03-142z/run.json
~/.cartographer/sites/linkedin.com/exploration-runs/explore-2026-05-29t18-33-48-440z/run.json
~/.cartographer/sites/linkedin.com/exploration-runs/explore-2026-05-29t18-35-13-888z/run.json
```

Verifier results:

- `linkedin_home_feed`: `ok: true`, 8 captures, 7 graph nodes, 297 graph edges, 34 write-risk edges, 0 missing artifacts, 0 mismatches
- `linkedin_messaging`: `ok: true`, 7 captures, 6 graph nodes, 235 graph edges, 27 write-risk edges, 0 missing artifacts, 0 mismatches
- `linkedin_notifications`: `ok: true`, 8 captures, 8 graph nodes, 309 graph edges, 28 write-risk edges, 0 missing artifacts, 0 mismatches

These runs proved classifier coverage for authenticated LinkedIn feed, messaging, notifications, my network, jobs, learning, profile analytics, preferences, and profile routes. They also proved every captured surface now emits node match, control diff, candidate edges, edge reconciliation, and graph mutation artifacts.
