# Deterministic Site Graph Product Plan

Cartographer's product direction is a local-first deterministic site graph, not a harness product. The existing harness, capture, verification, topology, and promotion code remains valuable; the plan is to reuse those modules while moving the durable product center into a SQLite-backed graph and graph CLI.

## 1. Freeze The Product Shape

Record the direction in a short ADR or architecture note:

- Cartographer is a local-first deterministic site graph.
- The harness is an ingestion/backfill worker, not the product interface.
- Agents plan against the graph, execute graph actions, and inspect evidence.
- Generated `SKILL.md` files become thin instructions around the graph CLI, not the durable memory layer.

This step prevents accidental deletion of useful harness work while changing the product center of gravity.

## 2. Probe `codebase-memory-mcp`

Run a focused probe of the installed `codebase-memory-mcp`:

- `index_repository`
- `search_graph`
- `query_graph`
- `trace_path`
- `detect_changes`
- schema inspection
- SQLite locking and WAL behavior

The output should be a short "copy / adapt / avoid" note. Do not implement Cartographer's storage layer until this probe is complete.

## 3. Define The Durable Graph Contract

Define storage-neutral TypeScript interfaces before adding SQLite:

- `Surface`: stable logical website state.
- `Capture`: one observed revision of a surface.
- `Control`: interactable element observed in a capture.
- `Action`: logical graph edge from one surface to another, or an in-place operation.
- `ActionBinding`: current executable binding for an action, such as selectors or URL templates.
- `GraphEvent`: append-only mutation/event history.
- `VerificationRun`: precondition and postcondition evidence for an action execution.
- `BrowserLease`: profile/session ownership record.

This contract should reuse the existing concepts in `src/explorer/post-capture.ts`, `src/explorer/topology.ts`, and `src/site-graph.ts`.

## 4. Add SQLite Behind A Storage Interface

Add a `SiteGraphStore` interface with two adapters:

- current JSON/artifact-backed adapter
- new SQLite adapter

Do not rewrite the harness first. Existing commands should keep working while new graph commands can start using SQLite.

## 5. Move `graph-candidate.json` Into SQLite

Port the current raw graph shape into database rows:

- graph nodes become `surfaces` plus latest `captures`
- candidate edges become `actions`
- selector candidates and control evidence become `controls` and `action_bindings`
- node match, control diff, and edge reconciliation become graph events and verification records

Keep compatibility exports to `graph-candidate.json` during the transition so existing verification and visualization keep working.

## 6. Keep Heavy Evidence On Disk

Do not store screenshots, full HTML, AX trees, or full markdown blobs in SQLite at first.

SQLite stores:

- paths
- hashes
- compact summaries
- current binding state
- graph status
- event history

Existing artifact directories remain the source of heavy evidence.

## 7. Port Topology To Store Queries

Refactor topology code so it reads through `SiteGraphStore`.

Then add SQL-backed traversal for:

- safe path finding
- incoming/outgoing action inspection
- unresolved target inspection
- write-risk action inspection
- unreachable surface detection

Recursive SQL CTEs should replace in-memory BFS only after the DB schema is stable.

## 8. Build The Deterministic Graph CLI

Ship the product-facing graph CLI before watcher and embedding work:

```bash
cg graph summary <domain>
cg graph node <domain> <surface-id>
cg graph actions <domain> <surface-id>
cg graph path <domain> <from-surface-id> <to-surface-id>
cg graph open <domain> <surface-id>
cg graph exec <domain> <action-id>
cg graph verify <domain> <action-id>
cg graph diff <domain>
```

This is the first real product surface: deterministic browsing through graph inspection and graph execution.

## 9. Demote Harness To Ingestion

Keep the existing harness modules, but route their output into the store:

- `surface-capture.ts` remains the page evidence collector.
- site adapters remain the goal/crawl policy seam.
- login/session handling remains in place.
- verification and visualization remain useful.
- `explore-harness` becomes conceptually `cg graph crawl` or `cg graph ingest`.

The harness should append graph events instead of rewriting one candidate file as the primary state.

## 10. Add Incremental Graph Updates

Graph updates should be append-only and auditable.

Useful event types:

- `surface_seen`
- `surface_matched`
- `capture_recorded`
- `control_seen`
- `action_seen`
- `binding_drifted`
- `binding_promoted`
- `action_missing`
- `verification_passed`
- `verification_failed`

The latest graph is a materialized view over event history, not an opaque artifact overwrite.

## 11. Add Watch Mode

After DB and CLI work, add:

```bash
cg graph watch <domain> --profile default
```

Watch mode observes:

- URL transitions
- DOM/control changes
- network transitions
- page readiness
- action postconditions

It should compare observations to the current graph and propose or record graph updates. It should not silently overwrite trusted bindings from one noisy observation.

## 12. Add Search And Semantic Matching

Start with deterministic search:

- FTS over surface titles, URL shapes, headings, control names, labels, and nearby text.
- structured filters for risk, trust, action kind, target status, and domain.

Then add compact embeddings inspired by `codebase-memory-mcp`:

- quantized page vectors
- quantized control/action vectors
- semantic node/action search
- semantic drift suggestions

Embeddings should assist search and reconciliation. They should not be the sole authority for executing an action.

## 13. Execute Through Graph Actions

Unify execution around graph actions:

1. Find action.
2. Check risk and required confirmation.
3. Open source surface.
4. Apply current action binding.
5. Verify target surface or postcondition.
6. Record a `VerificationRun`.
7. Promote or downgrade the binding based on evidence.

Trusted CLI promotion remains valuable, but trusted commands attach to graph actions.

## 14. Move Browser Leases Into SQLite

Only migrate browser leases after the graph database is proven.

Current `profile-lock.ts` and `browser-session.json` already work. Replace them later with transactional SQLite leases when WAL/checkpoint behavior is understood under real concurrent CLI use.

## 15. Upgrade Agent Contracts And Skills

Generated agent contracts and `SKILL.md` files should point agents at graph commands:

- inspect graph
- find action
- execute action
- verify result
- fall back to graph ingest only when no known action exists

The graph DB is the durable memory. Skills are instructions for using it.

## 16. Dogfood Across Three Site Types

Use three classes of sites before calling the product ready:

- `ycombinator.com`: public deterministic navigation.
- `linkedin.com`: authenticated app navigation.
- `x.com` or `instagram.com`: drift-heavy logged-in UI.

Each site must support crawl/index, graph query, safe path traversal, action execution, verification, and drift update.

## 17. Product MVP Readiness

MVP is ready when:

- a site can be indexed into `site-graph.db`
- an agent can search surfaces and actions
- a safe path can be found and executed
- drift creates a graph update instead of only a broken run
- heavy evidence remains inspectable
- generated skills use the graph instead of replacing it
- existing harness, capture, verification, and promotion code has been reused rather than thrown away

The first implementation move should be the storage abstraction plus SQLite graph schema. Watch mode, embeddings, and UI come after the durable graph and graph CLI exist.
