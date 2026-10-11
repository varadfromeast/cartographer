# Graphify and evolving webpage memory

Inspected 2026-10-11. Primary evidence is installed **graphifyy 0.9.85**, at `/Users/varad/.cache/uv/archive-v0/FXlaqTGJfGaZqfRlIcSBE/graphify`, and this Cartographer checkout. This report describes that installed version, not an assertion about the latest upstream release. Package metadata identifies upstream as https://github.com/Graphify-Labs/graphify.

## What the existing Graphify trial demonstrates

[Trial README](tmp/graphify-storage-trial/README.md) explicitly says a custom `scan.mjs` adapter measured folders and constructed graph-compatible JSON. Graphify clustered, queried, explained, and exported it; it did not discover ownership or cleanup safety. The 99-node/98-edge result establishes support for an externally produced domain graph. It does **not** demonstrate live webpage extraction, browser state recognition, action execution, or semantic change repair.

## Actual algorithms found

- **Clustering:** `cluster.py:106` prefers Leiden, then falls back to NetworkX Louvain at line 169. `remap_communities_to_previous` (line 434) greedily matches old/new communities by intersection size, preserving community IDs where possible. These group connected entities; they do not establish whether two controls are the same actionable entity.
- **Deduplication:** `dedup.py:1` describes normalization → entropy gate → MinHash/LSH candidate blocking → Jaro-Winkler verification → same-community boost → union-find merging. `deduplicate_entities` (line 649) has optional LLM tie breaking. Numerous guards are specific to code/file identities. Reusing label similarity directly for webpage controls risks merging separate “Save”, “Delete”, or repeated table-row buttons.
- **Incremental extraction:** `cache.py:1047` loads extractions by matching content hashes; semantic cache additionally accounts for prompt identity. `build.py:2113` defines `build_merge`: source files that were re-extracted replace their earlier contribution per AST/semantic tier; untouched sources survive; deleted sources are pruned. This is useful provenance-based replacement, not a browser state transition history or event log.
- **Retrieval:** `serve.py:559` implements lexical node scoring using normalized terms, inverse document frequency, exact/prefix bonuses, term coverage, and a trigram prefilter. `serve.py:1373` chooses seeds, traverses BFS/DFS (default depth 3), and emits a token-budgeted subgraph (default 2,000 tokens). The inspected normal query path is not embedding search or personalized PageRank.
- **Graph diff:** `analyze.py:621` compares node identity sets and edge identities/direction. The inspected implementation reports added/removed nodes and edges; do not equate it with complete attribute-level drift tracking or verified behavioral equivalence.

## What Cartographer already supplies

[Architecture](architecture.md) defines state/surface nodes and action transitions, with evidence and trust metadata. [post-capture.ts:837](src/explorer/post-capture.ts#L837) already performs node matching; currently it chooses exact node ID, otherwise the first matching URL shape. [post-capture.ts:872](src/explorer/post-capture.ts#L872) compares controls by stable ID, then role/label/href signature, then role/href for renaming; unmatched old controls become missing and unmatched new controls become candidates. This is concrete domain-specific reconciliation, but URL shape alone cannot distinguish modal/tab/permission/data states.

[sqlite-graph.ts:121](src/explorer/sqlite-graph.ts#L121) begins an import transaction and deletes domain-specific surfaces, actions, search, and import metadata before replacing them. Durable incremental database history is therefore still absent from that path, even though capture artifacts retain evidence.

## Recommended adaptation (proposal, not measured superiority)

Represent a website at two connected levels:

1. **Semantic structure:** app → route template → region/component → controls, plus row/entity context. Capture DOM/accessibility structure deterministically. Store role, accessible label, structural neighbors, stable attributes, scoped selector candidates, and region fingerprints.
2. **Behavior:** state → parameterized action → observed state/outcome. Record preconditions, verified postconditions, freshness, observed successes/failures, and the evidence that supports each action. A UI graph alone cannot prove clicking a button succeeded.

Separate reusable templates from data instances: “invoice row / open invoice” should be reusable across invoice IDs, while selected entity, tenant, permissions, modal state, and meaningful status values remain in runtime context. Overly aggressive template merging would make actions unsafe or incorrect.

The most promising optimization is **dependency-scoped semantic validation and repair**. This is stronger than simply ignoring unrelated page changes: a replay cache that omits page content can already tolerate those changes, but does not thereby establish that its action remains correct. A learned action references its target region, semantic identity, preconditions, and postcondition. Recompute hashes/diffs on newly observed regions; invalidate or re-ground only actions whose dependencies changed. Unchanged sidebar actions survive a changing activity feed. Use retrieval to send only the relevant region and a short candidate path to the reasoning model. A global graph crawl and community detection on every action would likely add cost.

Borrow Graphify's content hashing, provenance-scoped replacement, lexical seed selection, bounded traversal, and possibly offline community summaries. Keep control identity and execution semantics in Cartographer. Preserve temporal evidence separately from the current graph; Graphify's replacement semantics do not automatically retain past states. Use fuzzy matching to propose an identity repair, then validate it against live structure and outcome before trusting execution.

A useful experiment would compare exact action replay, whole-page invalidation, and region-dependent graph memory against the same executor, including cold-start learning cost, repeated workflows with new records, unrelated page churn, selector drift, ambiguous labels, permission changes, and same-URL modals. Measure completion rate and false-success rate alongside model tokens, latency, and maintenance work. Graph representation is a plausible mechanism; superiority remains an empirical question.
