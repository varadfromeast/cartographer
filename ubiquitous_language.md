# Cartographer Ubiquitous Language

## Core Terms

- **Cartographer**: the standalone system that records browser evidence, compiles compact site graphs, and emits deterministic site CLI commands.
- **Site graph**: a directed cyclic property graph of website surfaces and actions.
- **Surface**: a recognizable website state, such as Instagram home, inbox, thread, profile, explore, or post.
- **Action**: a directed transition or in-place operation available from a surface.
- **Workflow**: a useful sequence of graph actions for an agent to plan against.
- **Trusted command**: a reviewed deterministic CLI command stored in the catalog.
- **Fallback**: recorded Playwright-backed live browsing used when no trusted command fits.
- **Evidence tape**: structured record of fallback operations, state, selectors, rendered evidence, and summaries.
- **Surface artifact**: per-surface capture bundle written by the exploration harness: `surface.json`, `surface.md`, `stripped.html`, `screenshot.png`, `screenshot-overlay.png`, `aria-snapshot.yml`, and `ax-tree.json`.
- **Rejected tape**: evidence that review refused to promote. It remains useful graph input with downgraded trust.
- **Rerecord**: review disposition meaning “valuable action, but gather narrower/better evidence before promotion.”

## Graph Terms

- **Node**: graph object representing a surface. Nodes do not own CLI commands.
- **Edge/action**: graph object representing what can happen from one node to another. CLI commands attach here.
- **Implementation**: how an action can be executed. V1 supports `cli`, `fallback_observed`, and `none`.
- **Evidence ref**: compact pointer back to catalog entries, fallback tapes, operations, or review artifacts.
- **Trust**: whether an action is executable or only observed.
- **Risk**: what kind of platform effect an action may have.

## Trust Levels

- **trusted_cli**: reviewed command exists and can be called.
- **observed**: seen in fallback evidence, not trusted.
- **weak**: observed but selector/state evidence is brittle.
- **rerecord_required**: high-value candidate that needs a narrow rerun.
- **failed**: failed operation or polluted evidence.

## Risk Levels

- **safe_navigation**: navigation or state entry with no platform write.
- **read**: information gathering.
- **write**: modifies local composer/form state or may write platform state.
- **write_submit**: sends, posts, saves, publishes, or commits a write.
- **destructive**: delete, block, remove, unfollow, or similar.
- **unknown**: risk could not be classified.

## Runtime Terms

- **Task**: auditable user request boundary created by `cg begin-task` or `cg use`.
- **Segment**: narrower fallback intent inside a task.
- **Task browser**: Cartographer-owned Playwright browser session reused by commands and fallback for one task.
- **Playwright CLI adapter**: Cartographer wrapper around Playwright CLI/CDP operations.
- **Selector diagnostics**: evidence about visibility, match count, role/name, label, placeholder, aria attributes, contenteditable, form context, and nearby text.
- **Rendered postcondition**: success check against final rendered page state, not just command return codes.
- **Exploration harness**: live loop that owns session/login, captures surfaces, runs post-capture methods, and emits graph-candidate artifacts.
- **Surface classification**: post-capture method that assigns a logical surface type and proposed node id to a captured page.
- **Candidate edge**: post-capture action/control proposal extracted from a surface. Candidate edges include write and destructive controls with warning risk metadata instead of hiding them.
- **Graph mutation**: runtime artifact that records how a capture updates the graph candidate.
- **Resolved topology**: derived graph artifact that resolves candidate edge targets into known, self, uncaptured, external, write-risk, blocked, or unresolved target status.
- **Graph visualization**: local HTML artifact emitted from resolved topology so maintainers and agents can inspect graph shape, fanout, self-loops, unresolved edges, and write-risk edges without reading raw JSON.
- **Agent contract**: per-run JSON artifact that points external agents at the graph candidate, resolved topology, verification, visualization, safe navigation chains, and write-risk actions.
- **Surface drift**: changed UI evidence for the same logical node.
- **Node match**: planned post-capture method that decides whether a new capture is the same logical node as previous evidence.
- **Control diff**: planned method that compares old and new controls on the same logical surface.
- **Edge reconciliation**: planned method that marks edges as stable, drifted, renamed, missing, replaced, or new.

## Commands

- **`cg analyze-site <domain>`**: compile `site-graph.json` and `site-graph.md` from catalog and evidence.
- **`cg site-summary <domain>`**: compact graph overview.
- **`cg site-node <domain> <node-id>`**: inspect one surface and outgoing actions.
- **`cg site-actions <domain> <node-id>`**: list outgoing actions.
- **`cg use` / `cg shell`**: persistent recorded fallback shell.
- **`cg pw`**: one-shot recorded Playwright CLI fallback.
- **`cg exec-command`**: run a trusted site command.
- **`cg review-task`**: compile review artifacts after fallback.
- **`cg apply-promotion-decision`**: the only allowed catalog mutation path.
- **`cg explore-harness <domain>`**: run the live exploration harness. Supports Instagram capture and LinkedIn goal captures.

## Rules

- Cartographer is not a hidden natural-language browser agent.
- External agents should use the graph for planning and trusted commands for execution.
- Selectors stay out of the compact graph by default.
- Rejected evidence is still graph input, but never executable by default.
- Write actions are exposed with risk metadata and warnings. Capture and graph construction should not hide send, compose, follow, post, or input controls; execution and review layers record what happened.
- Risk metadata is a warning and planning signal, not a reason to remove the action from the graph.
- Catalog/SKILL/manifest mutation must go through generator or typed promotion policy.
- Stagehand is not part of the V1 runtime path.
