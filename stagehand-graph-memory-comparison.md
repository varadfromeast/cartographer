# Cartographer, Graphify, and Stagehand: source-based comparison

Inspected 2026-10-11. This is source research and a design proposal, not a performance benchmark. No live authenticated tasks were executed.

## Verdict

A persistent webpage graph is feasible and fits Cartographer's existing evidence capture. The valuable hypothesis is **dependency-aware browser memory**: parameterized actions attached to stable semantic regions, validated against current state, with explicit outcome checks and local repair. Graph conversion alone is insufficient. Stagehand already implements compressed trees, action caching, workflow replay, scoped context, and limited snapshot diffing.

## Sources and versions

- Stagehand current `main`: [f261c38b4dc50c39485f924e8599c1d3c6e37dc7](https://github.com/browserbase/stagehand/tree/f261c38b4dc50c39485f924e8599c1d3c6e37dc7), workspace version 4.0.0. Local inspection checkout: `/tmp/cartographer-stagehand-review-20261011`.
- Stagehand `v3`, also tagged `@browserbasehq/stagehand@3.7.3`: [3554b02b2a9165d5d09ece58ed74ec4e11f48f5e](https://github.com/browserbase/stagehand/tree/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e). Local inspection checkout: `/tmp/cartographer-stagehand-v3-review-20261011`.
- Installed Graphify: graphifyy 0.9.85. See [Graphify source investigation](graphify-web-memory-research.md).
- Additional snapshot/recovery findings: [Stagehand context investigation](stagehand-context-research.md).

These versions have different cache paths. Statements about the v3 local cache must not be conflated with v4's hosted cache.

## What Stagehand actually remembers

### v3 local action cache

`ActCache.prepareContext` hashes trimmed instruction, normalized URL, and sorted variable names. URL normalization sorts query parameters. It does **not** include DOM content or variable values. Thus a parameterized action can survive unrelated page changes and accept new argument values. With `cacheDir` configured, actions are stored in JSON files. Replay waits for the selector and invokes deterministic execution; repaired actions replace their cached bindings.

Sources: [ActCache.ts](https://github.com/browserbase/stagehand/blob/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e/packages/core/lib/v3/cache/ActCache.ts#L46), [key derivation](https://github.com/browserbase/stagehand/blob/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e/packages/core/lib/v3/cache/ActCache.ts#L190), [storage](https://github.com/browserbase/stagehand/blob/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e/packages/core/lib/v3/cache/CacheStorage.ts), [URL/selector utilities](https://github.com/browserbase/stagehand/blob/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e/packages/core/lib/v3/cache/utils.ts).

### v3 agent workflow cache

`AgentCache` additionally keys on instruction, start URL, sanitized execute options, configuration signature, and variable names. It replays a sequence of steps, including navigation, act, fillForm, scroll, waits, and keys. Changed action steps can refresh the saved trace. This is already workflow memory, so Cartographer should not claim replay as novel.

A freshness limitation in the inspected replay switch: extract/screenshot/ariaTree steps are not re-executed; replay returns a clone of the saved agent result. Thus remembering execution and obtaining fresh data need distinct contracts. This does not describe all extraction APIs or v4 behavior.

Source: [AgentCache.ts](https://github.com/browserbase/stagehand/blob/3554b02b2a9165d5d09ece58ed74ec4e11f48f5e/packages/core/lib/v3/cache/AgentCache.ts#L526).

### v4 server-side operation cache

The open client collects raw accessibility trees for all frames and sends method, session ID, URL, and method parameters to `/cache/get`. On a miss it runs inference and sends the cacheable output to `/cache/set`. Cached `act` actions execute again; cached observe/extract results can be returned directly. Failed replay triggers the inference path. A Browserbase API key and browser session ID are required to construct this cache context.

The caller can set a hit-count threshold. Model configuration is deliberately excluded from the client cache-key data. Locator-scoped requests bypass this cache because its current contract cannot key them safely. Screenshot extraction also bypasses it because DOM keys cannot represent image pixels.

**Visibility limit:** the public source explicitly delegates tree shaping, URL normalization, key computation, project gating, and Redis access to the API server. The exact hosted hashing/invalidation implementation is not in the inspected checkout; do not claim every DOM change necessarily causes a miss or quote a current TTL from older marketing material.

Sources: [cacheService.ts](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/cacheService.ts), [cacheClient.ts](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/clients/cacheClient.ts), [cached action replay](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/actService.ts#L250), [extract bypass](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/extractService.ts#L74).

## Optimizations beyond caching

Stagehand builds compact accessibility outlines with DOM/XPath mappings, collapses uninformative wrappers, removes duplicated text, supports locator-focused context, and shares DOM indexes across frames during a capture. These reduce input size and browser calls without requiring persistent memory.

For a two-step action, it recaptures the page after step one and feeds new outline lines to the second inference. `diffCombinedTrees` compares trimmed line sets. It does not encode deleted nodes, moved nodes, or stable identity correspondence. If the difference is empty, the caller sends the full next outline. The second snapshot still needs to be captured.

Sources: [capture pipeline](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/understudy/a11y/snapshot/capture.ts), [AX pruning](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/understudy/a11y/snapshot/a11yTree.ts), [two-step inference](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/actService.ts#L199), [line-diff implementation](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts#L76).

Self-healing is primarily reactive selector recovery: on eligible failure, capture current context, infer a new selector from the action description, and retry. The inspected deterministic success path does not independently verify the requested business outcome. A wrong but still clickable match could therefore escape error-triggered healing; this is an inference from the code, not a reproduced bug.

Source: [execution and healing](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/actService.ts#L332).

## Proposed graph model

Use connected representations with different lifetimes:

1. **Structure:** application → route template → regions → controls. Use DOM containment, accessibility landmarks, labels, form ownership, and entity context as primary evidence. Fuzzy identity matching produces candidates, not execution authority.
2. **State and behavior:** current state + parameterized action → verified resulting state/effect. State includes active dialog/tab, selected record, permissions, and relevant values, not URL alone.
3. **Evidence and dependencies:** each binding references the region, target identity, preconditions, postcondition, capture revision, and success/failure evidence that support it.

Separate templates from instances. A table's Open Invoice action can be parameterized by invoice ID; all buttons labelled Open must not collapse into a single identity. Keep tenant/account and authorization context in matching and validation scope. Cache an extraction recipe separately from fresh invoice values.

For example: invoice-list state → open_invoice(invoice_id) → invoice-detail state. The action depends on the invoice table template, the specific row identity, and absence of a blocking dialog. A changing activity feed should not invalidate it; a selected-account change may.

## Strongest optimization hypothesis

Treat memory maintenance like an incremental build system:

- Capture visited regions lazily and compute separate structural and content fingerprints. Keep meaningful status, enabled/selected values, and entity identity in the relevant fingerprint; stripping all dynamic content is incorrect.
- Track explicit action dependencies. A region change marks dependent bindings for revalidation; unrelated actions stay reusable.
- Use mutation events as hints and batch them after settling. Reconcile after navigation/frame replacement and periodically capture a baseline because mutation streams can miss state and coverage changes.
- Retrieve a task-specific region/subgraph, not the whole website. Graphify's lexical seed selection and bounded traversal can support this. Typed-edge traversal should avoid generic containment hubs consuming the token budget.
- Execute unchanged verified bindings directly, perform cheap precondition/target checks, then validate the outcome. Re-ground only the changed region when possible; escalate to broader context when local repair is ambiguous.
- Learn short reusable workflow fragments, keeping verification boundaries around effects. Compose fragments for new tasks rather than requiring an identical full prompt/trace.

This may improve generalization, false-success detection, and repair cost. It is not automatically faster on an unchanged exact replay: Stagehand can already avoid inference there, and graph validation adds overhead. More graph nodes are not themselves an optimization.

Use Graphify's hashing, provenance-aware replacement, dedup candidate generation, and budgeted retrieval. Community detection can help offline summaries; DOM/accessibility containment is a better first source of component boundaries. Do not run global clustering or semantic extraction after every click.

## Changes needed in Cartographer

Existing capture already stores controls, context, control groups, and content/control hashes. Existing reconciliation detects stable, renamed, missing, and selector-drifted controls. Preserve that work.

- Replace URL-shape-only state fallback with state predicates: [post-capture.ts](src/explorer/post-capture.ts#L837).
- Separate semantic control identity from current selector: the current stable ID includes the leading selector, so selector changes alter identity: [surface-capture.ts](src/explorer/surface-capture.ts#L280).
- Add region provenance, dependency references, and revision/upsert semantics to SQLite; imports currently replace the domain: [sqlite-graph.ts](src/explorer/sqlite-graph.ts#L121).
- Replace URL-based action success with actual postconditions: [graph-cli.ts](src/explorer/graph-cli.ts#L450).

## Experiment that can decide whether to revive it

Use one controlled application and a common executor. Compare Stagehand's configured caches, a simple parameterized action registry, and Cartographer's region/dependency graph. This ablation checks whether the graph earns its maintenance cost.

Run unchanged repeat tasks, new record IDs, reordered rows, unrelated feed churn, renamed/moved controls, same-URL modal states, permission changes, and wrong-but-clickable selectors. Verify effects from an independent app-state oracle. Measure task success, false-success rate, model tokens, wall-clock latency, capture/validation/repair cost, and initial learning cost.

The relevant break-even condition is: initial graph-building cost + cumulative graph lookup/validation/update/execution cost < cumulative baseline cost, while maintaining or improving correctness. No numerical speedup is claimed before this comparison.
