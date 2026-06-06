# Cartographer Architecture

Cartographer is a standalone, local-first browser evidence system for building compact site graphs and deterministic CLI workflows.

It is not a hidden browser agent. It does not use Stagehand on the runtime path. The live browser substrate is Playwright plus the Playwright CLI/CDP adapter, wrapped by Cartographer so every useful fallback operation leaves reviewable evidence.

## Product Direction

Cartographer's durable product shape is graph-first: a local-first deterministic site graph is the interface that agents inspect, plan against, and execute through. Browser capture, verification, topology resolution, visualization, and promotion remain important supporting systems, but the harness is an ingestion and backfill worker rather than the product interface.

Generated per-site `SKILL.md` files should stay thin. They should teach agents how to query the graph CLI, choose graph actions, execute those actions, and inspect evidence; they should not become the durable memory layer for a site.

The first graph-first MVP is a SQLite-backed YC vertical slice:

```bash
cg graph import ycombinator.com <exploration-run>
cg graph search ycombinator.com "security startups"
cg graph path ycombinator.com yc_home <surface-id>
cg graph actions ycombinator.com <surface-id>
```

It imports existing `graph-candidate.json` and on-disk page evidence, indexes surface text with SQLite FTS5, traverses canonical safe actions, and preserves raw action evidence for inspection. It intentionally proves graph-guided discovery and traversal before adding embeddings, event history, live harness ingestion, or browser leases.

V1 materializes fastest as an offline site-graph compiler:

```bash
cg analyze-site instagram.com
cg site-summary instagram.com
cg site-node instagram.com direct_thread
cg site-actions instagram.com direct_thread
```

The graph is built from evidence we already have:

- trusted catalog commands
- task-scoped fallback tapes
- review artifacts
- rejected tapes, included with downgraded trust
- rendered evidence summaries and write-grounding probes

The graph helps an external agent plan a task without reading raw selectors or replaying every old browser trace.

The harness pipeline is explicit:

```text
explore / live task
-> evidence capture
-> classifySurface
-> extractCandidateEdges
-> recordGraphMutation
-> matchExistingNode / diffSurfaceControls / reconcileEdges
-> graph creation
-> surface packet emission
-> promotion candidate review
-> trusted CLI promotion
-> external agent graph+CLI execution
```

`cg analyze-site <domain>` is the graph creation step. It loads the trusted catalog and fallback/review evidence, synthesizes graph nodes/actions/workflows, writes `site-graph.json` and `site-graph.md`, then emits surface packets beside the graph.

## Runtime Layers

1. **Task lifecycle**
   `begin-task`, `use`, `shell`, `pw`, `review-task`, and `complete-task` create an auditable task boundary.

2. **Playwright fallback substrate**
   `cg use`, `cg shell`, and `cg pw` attach to a Cartographer-owned browser session. Commands are recorded as structured operations with URL, state, selector diagnostics, rendered summaries, and write-grounding evidence where available.

3. **Trusted CLI catalog**
   Promotion decisions can add deterministic site commands to the catalog. Catalog mutation must go through `apply-promotion-decision`.

4. **Site graph compiler**
   `analyze-site` compiles catalog commands and fallback evidence into `site-graph.json` and `site-graph.md`.

5. **Generated agent contract**
   `emit-skill` and `expose-skills` generate the per-site `SKILL.md` and `manifest.json` used by external agents.

6. **Exploration harness**
   `explore-harness` owns saved-session/login flow, captures live surface artifacts, runs post-capture methods, and writes graph-candidate artifacts. It crawls same-domain navigation edges from a rooted goal up to a bounded depth. The harness never executes write-risk controls during crawl.

## Graph Model

Cartographer uses a directed cyclic property graph.

- **Node**: a website surface/state, such as `home`, `direct_inbox`, `direct_thread`, or `profile`.
- **Action**: a transition or in-place operation from one node to another.
- **Workflow**: a compact chain of actions useful for planning.
- **Implementation**: optional executable backing for an action.

Trusted CLI commands attach to actions, not nodes. For example, `open-thread-by-name` is an action from `direct_inbox` to `direct_thread`; `direct_thread` itself is just a surface.

Selectors are intentionally hidden from the compact graph. They remain in evidence artifacts and CLI implementations. External agents should plan with the graph and call trusted commands when an action exposes a trusted CLI implementation.

## Trust Model

Actions can be:

- `trusted_cli`: reviewed command exists.
- `observed`: seen in fallback evidence, not trusted.
- `weak`: evidence exists but selectors/state are brittle.
- `rerecord_required`: valuable action, but evidence is not promotion quality.
- `failed`: failed or polluted fallback evidence.

Risk is tracked separately:

- `safe_navigation`
- `read`
- `write`
- `write_submit`
- `destructive`
- `unknown`

For V1, trusted CLI actions are executable from the graph. Write actions are exposed instead of hidden: candidate edges and trusted actions carry risk metadata (`write`, `write_submit`, `destructive`, or `unknown`) and warning text, but the graph still represents the surface honestly. Write-capable commands emit rendered postcondition evidence for review.

Exploration harness candidate edges are intentionally inclusive. Controls such as compose, follow, send, message, post, or inputs remain in `candidate-edges.json`; they are flagged with warning-level risk rather than filtered out. Execution policy belongs to the caller/task mode, not to surface capture.

## Surface Drift Reconciliation

UI components can change without changing the logical surface. Cartographer should not rebuild the entire graph when a site moves buttons, renames controls, or changes DOM structure.

Implemented harness stages:

```text
captureSurface
-> classifySurface
-> matchExistingNode
-> diffSurfaceControls
-> extractCandidateEdges
-> reconcileEdges
-> recordGraphMutation
```

`matchExistingNode` decides whether a new capture is the same logical node as an existing graph node. `diffSurfaceControls` compares old and new controls by role, accessible name, href, landmark, nearby text, selector candidates, and visual location. `reconcileEdges` marks existing edges as `stable`, `drifted_selector`, `renamed`, `missing`, `replaced`, or `new_candidate`.

Each stage emits a per-surface artifact (`node-match.json`, `control-diff.json`, `edge-reconciliation.json`) and the run verifier checks that these artifacts agree with the final `graph-candidate.json`.

## Resolved Topology

`graph-candidate.json` remains the raw candidate graph. It preserves candidate edges with labels, hrefs, priority, and write-risk metadata. Agents should not have to reinterpret that raw graph for planning.

Cartographer therefore derives `graph-topology.json` through `resolveExplorationTopology`:

```text
graph-candidate.json
-> resolve edge target URLs
-> match targets to known graph nodes
-> classify target status
-> compute reachability, duplicate pairs, self-loops, and unresolved targets
-> graph-topology.json
```

Target status values:

- `known`: safe navigation edge reaches another captured node.
- `self`: safe navigation edge resolves back to its source node.
- `uncaptured`: safe same-domain navigation target was not captured in this run.
- `external`: navigation target leaves the configured domain.
- `write_risk`: action carries write-risk metadata and is excluded from safe topology reachability.
- `blocked`: non-navigation action without write risk.
- `unresolved`: target URL could not be resolved.

This makes resolved topology the interface for graph-quality checks, visualization, path planning, and external-agent contracts. Raw candidate edges remain the evidence-rich implementation detail.

## Harness Adapter

The harness uses a per-site exploration adapter for goal URL resolution, crawlability, route priority, and default fanout. This keeps the live crawl loop domain-agnostic: the harness owns progress, resume, capture transactions, browser recovery, and frontier mechanics; the adapter owns website-specific policy.

This is now the preferred seam for adding a new site. A new adapter should define supported exploration goals, default max navigation fanout, crawlable URL rules, route priority for frontier ordering, and any site-specific edge priority adjustments.

Classifier rules still live in post-capture code today; moving them behind the same adapter is the next natural deepening step when a second public-site crawler needs broader classifiers.

## Visualization And Agent Contract

`exploration-visualize` writes a local `graph.html` beside the run. The visualization is intentionally simple: it renders captured surfaces by type, known resolved navigation pairs, and inspection tables for unresolved, uncaptured, external, and write-risk edges.

`exploration-agent-contract` writes `agent-contract.json`. This is the handoff artifact an external agent should read before continuing a run. It includes graph paths, topology health, safe navigation chains, write-risk actions, and the exact CLI commands for summary, topology, visualization, verification, graph, and progress.

## Harness Interfaces

The harness is designed around explicit TypeScript contracts rather than loose JSON:

- `HarnessRunConfig`: caller input for a live crawl. It chooses domain, goal, maximum crawl depth, task id, and profile.
- `HarnessCrawlPolicy`: the resolved execution policy written into every run. Today it is intentionally conservative: same-domain navigation only, bounded navigation fan-out, no click execution, and no write-risk following.
- `HarnessCaptureSummary`: the run-level index for one captured surface. It points to the surface, screenshot, classification, node match, control diff, candidate edges, edge reconciliation, and graph mutation artifacts.
- `PostCaptureArtifacts`: the internal bundle returned after one capture has been classified, diffed, edge-extracted, reconciled, and merged into the graph candidate.
- `ExplorationHarnessResult`: the top-level result written to `run.json`, including run id, run directory, crawl policy, capture summaries, and browser-close state.
- `SavedSessionStatus`: the login/session health check. It reports whether the harness profile is reachable over CDP, whether expected auth cookie names are present, whether the page looks login-like, and where the browser-session record lives. Cookie values are never printed.
- `ExplorationRunVerification`: the verifier result for a completed run. It checks missing artifacts, classification mismatches, graph-node consistency, graph-edge consistency, write-risk warnings, and reconciliation summary totals.
- `withBrowserProfileLock`: the cross-process guard around live browser-profile access. It serializes `session-status` and `explore-harness` per domain/profile so concurrent CLI checks do not drive the same CDP page at once.
- `TaskBrowserLease`: the per-command browser lease stored in `browser-session.json`. Each lease records the task id, owner process id, and update time; session status normalizes old records and prunes leases whose owner process is gone.

## Browser Substrate Direction

Cartographer should not require the user's everyday browser. The default local substrate should be a Cartographer-owned Playwright browser install/profile, because Playwright can install and run pinned Chromium/WebKit/Firefox builds and supports hermetic local browser storage. The current Chrome path override remains useful, but it should be a fallback or explicit override rather than the product assumption.

Alternative CDP backends should be evaluated behind a browser-provider boundary:

- Obscura: promising packageable CLI/CDP backend for fetch, scrape, and `serve`; not currently available on this machine's `PATH`.
- Lightpanda: promising open-source headless CDP browser for low-memory crawl/read workloads, but it is not a full visual browser and has partial Web API coverage.
- Browserless: relevant self-hosted Docker browser service with Playwright/Puppeteer support, but its license/commercial terms need review before bundling.
- Browserbase: useful managed cloud browser infrastructure with a free tier, but it is cloud-first and not an on-prem/packageable free browser runtime.

The reusable architecture should therefore target a `BrowserProvider` style boundary: local Playwright bundled browser first, optional external CDP endpoint second, cloud providers only as explicit integrations.

## Visual Review Gate

DOM checks are not enough for write promotion because modern apps can keep draft text in editable controls, virtualize message lists, or change DOM shape while the rendered state is clear to a user.

For write-capable CLI runs, Cartographer now creates a formal `visualReview` artifact:

- final screenshot path
- URL and task/process subject
- bound expected outcome, such as the concrete message text
- narrow VLM question
- explicit checks that distinguish rendered success from input/composer state
- pending/reviewed verdict field

The artifact is an evidence layer, not the execution authority. The graph owns navigation, the CLI owns deterministic action execution, DOM postconditions remain deterministic checks, and visual review verifies whether the final rendered state actually matches the declared outcome.

## Instagram V1

Current trusted Instagram actions:

- `open-inbox`
- `open-profile-by-username`
- `open-thread-by-name`
- `send-message-current-thread`

The graph currently shows the DM workflow as partial:

```text
open_inbox -> open_thread_by_name -> send_message_current_thread
```

`send_message_current_thread` is a trusted write-submit command. It is graph-executable, requires `--confirm-write`, and emits a pending visual review artifact after confirmed execution.

## LinkedIn Harness Experiment

LinkedIn is currently supported only through `explore-harness`, not the older task/skill command surface.

Supported live goals:

- `linkedin_home_feed`
- `linkedin_search_results`
- `linkedin_messaging`
- `linkedin_notifications`
- `linkedin_my_network`

Earlier five-goal runs verified the current post-capture loop:

```text
captureSurface
-> classifySurface
-> matchExistingNode
-> diffSurfaceControls
-> extractCandidateEdges
-> reconcileEdges
-> recordGraphMutation
```

Each run emitted surface artifacts and graph-candidate artifacts. This proves the method shape across varied surfaces, but not yet full graph traversal or CLI promotion for LinkedIn.

## Stagehand Boundary

There is no Stagehand runtime dependency in Cartographer V1. Earlier docs described a Stagehand-backed replay layer; that is obsolete.

The replacement is:

- Playwright browser sessions for task execution
- Playwright CLI/CDP adapter for fallback recording
- Cartographer evidence stores and review gates for trust
- deterministic CLI emitters for promoted commands

Legacy fallback tapes may still contain old source labels such as `stagehand_fallback` for compatibility. That label is historical data, not a runtime dependency.
