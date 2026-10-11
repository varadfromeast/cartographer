# Stagehand context and recovery source inspection

Inspected public Stagehand checkout at commit `f261c38b4dc50c39485f924e8599c1d3c6e37dc7` in `/tmp/cartographer-stagehand-review-20261011`. This is static source inspection, not a benchmark or live-browser test. Paths below are relative to that checkout. The inspected layout is the v4 extension implementation; do not silently generalize to deployed v3 services or private Browserbase infrastructure.

## Beyond caching

- **Hybrid DOM/accessibility representation.** `packages/extension/understudy/a11y/snapshot/capture.ts:43` describes the pipeline: index DOM metadata, fetch accessibility trees, attach XPath/tag/URL maps, stitch frame outlines. `a11yTree.ts:20` fetches `Accessibility.getFullAXTree`. The model-facing representation is a compact role/name tree with encoded IDs, not raw HTML. `treeFormatUtils.ts:8` serializes it; selected/checked states are rendered at line 17. `actService.ts:470` maps inferred IDs back to concrete XPath selectors.
- **Pruning.** `a11yTree.ts:170` builds hierarchy and collapses empty or single-child structural wrappers; line 268 removes static text children duplicating the parent name. This already performs a useful graph/tree reduction before inference.
- **Targeted context.** `capture.ts:177` implements the locator fast path: resolve the owning frame, generate its DOM/AX data, and return a scoped outline; fall back to the whole page if scoping fails. Important limit: `a11yTree.ts:35` still fetches the full AX tree for the chosen frame and then filters its descendants (lines 57–95). Scope reduces model context and avoids other frames; it is not an incremental subtree-only AX fetch. `observeService.ts:85` and `extractService.ts:97` wire locator and ignore-locator options into snapshots.
- **Shared capture-time indexing.** `capture.ts:325` deduplicates CDP sessions and builds one DOM index per session; frame slices reuse it at line 355. `domTree.ts:237` explains avoiding repeated DOM calls. This is an index local to a capture, not persisted cross-visit semantic memory.
- **Changed-content inference.** `actService.ts:199` recaptures after the first action of a two-step operation and sends `diffCombinedTrees(old, new)` to the second inference; at line 223 it falls back to the full new tree when the diff is empty. `treeFormatUtils.ts:76` implements set subtraction over trimmed lines. It represents additions or changed serialized lines, but does not encode removals, moves, old/new correspondence, or mutation dependencies. It also still captures the whole requested snapshot before diffing.

## Recovery and its limits

- `actService.ts:332` attempts deterministic execution. On an eligible execution error, if `selfHeal` is enabled, it calls `selfHealAction` at line 399. Timeout/progress exhaustion propagates rather than healing indefinitely.
- Healing captures a fresh full snapshot (`actService.ts:419`), asks the model to resolve the action from its description again, then retries using the new selector while preserving the original method and resolved arguments (`actService.ts:440`). This is reactive selector repair, not an explicit learned state-transition model.
- Cached-action replay (`actService.ts:254`) disables healing inside each replayed action and throws on failure so the cache interceptor can run fresh inference. This is separate from explicitly supplied Action healing.
- Deterministic success at `actService.ts:369` means the underlying operation returned; it does not independently establish the user's semantic postcondition. Thus a stale XPath that still resolves to the wrong clickable element can evade this error-triggered repair path. This is an architectural risk inferred from control flow, not an observed failing test.
- Execution machinery includes frame/shadow-aware selector resolution (`handlers/handlerUtils/actHandlerUtils.ts:48`) and network/DOM settling (`actHandlerUtils.ts:459`). These stabilize execution but do not prove a business outcome.

## Implication for Cartographer

Simply converting a page to a graph would overlap with Stagehand's existing compact accessibility tree plus DOM maps. The defensible hypothesis is persistent, task-relevant **state/action/effect memory**, with stable semantic identities, region-level fingerprints, local invalidation, retrieved subgraphs, and explicit outcome checks. Stagehand's two-step diff establishes that change-only inference is already useful, while its implementation leaves room for persistent identity-aware deltas and dependency-aware invalidation.

The inspected service/snapshot paths contain no persistent semantic site graph or dependency-based incremental invalidation. This is bounded negative evidence: unrelated code, hosted behavior, and later commits were not exhaustively audited. Improvements should be benchmarked against Stagehand with caching, locator scope, and its existing changed-content path enabled, including learning, verification, and repair costs.
