# YC Harness Continuation

## Current Goal

Use `https://www.ycombinator.com/` as the live proving ground for Cartographer's exploration harness.

The goal is not just to map YC. The goal is to harden the harness so an external agent can use only Cartographer's graph artifacts and CLI commands to keep working deterministically for a long run.

The desired end state:

- crawl rooted from the YC home page with bounded max depth
- capture every discovered surface with durable artifacts
- classify surfaces into stable graph nodes
- retain all click/action candidates with write-risk metadata
- expose useful graph/node/action CLI commands
- replay graph actions and chains deterministically through the CLI
- survive browser restarts, manual browser quits, transient navigation errors, and resumed runs
- keep improving the harness whenever a crawl exposes a weak edge, duplicate node, missing classifier, or nondeterministic replay

## Repo And Runtime

Repo:

```text
/Users/varad/V/repo/cartographer
```

Primary YC run directory:

```text
/Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/explore-2026-05-30t18-46-27-819z
```

Resume smoke run:

```text
/Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/resume-smoke-2026-05-31
```

## Current Harness Status

The harness has moved from single-root surface captures to a real crawler:

- `explore-harness` accepts `--max-depth`, `--max-edges`, and `--max-captures`.
- YC crawling is rooted from the home page and constrained to `www.ycombinator.com` / `ycombinator.com`.
- Auth/admin/static/off-domain routes are filtered out before capture.
- Non-crawlable redirects, such as account/login redirects, are skipped before committing graph state.
- Progress is written during the crawl to `progress.json`.
- `run.json` is written after each committed capture instead of only at the end.
- Captures are transactional: only stable post-capture summaries are committed into `run.json`.
- Manual browser/page closure and transient navigation errors are retried with a fresh page.
- Resume support exists through `--resume latest|<run-dir>`.
- Resume reconstructs the frontier from committed `candidate-edges.json` artifacts and continues from the next capture index.

## Current Graph And CLI Status

Current graph CLI commands include:

```bash
node dist/cli.js exploration-summary ycombinator.com latest
node dist/cli.js exploration-graph ycombinator.com latest
node dist/cli.js exploration-progress ycombinator.com latest
node dist/cli.js exploration-topology ycombinator.com latest --write
node dist/cli.js exploration-visualize ycombinator.com latest
node dist/cli.js exploration-agent-contract ycombinator.com latest
node dist/cli.js exploration-node ycombinator.com <node-id> latest
node dist/cli.js exploration-actions ycombinator.com <node-id> latest
node dist/cli.js exploration-path ycombinator.com <from-node> <to-node> latest
node dist/cli.js exploration-chain ycombinator.com latest node:<node-id> action:<edge-id>
node dist/cli.js exploration-open-node ycombinator.com <node-id> latest --profile default
node dist/cli.js exploration-open-action ycombinator.com <edge-id> latest --profile default
node dist/cli.js exploration-exec-action ycombinator.com <edge-id> latest --profile default
node dist/cli.js verify-exploration-run ycombinator.com latest --write
node dist/cli.js session-status ycombinator.com --goal yc_home --profile default
```

`exploration-chain` supports:

```text
node:<node-id>
action:<edge-id>
edge:<edge-id>
input:<edge-id>=<value>
select:<edge-id>=<value>
```

Current deterministic replay checks have passed for:

- opening `yc_deals`
- opening a known action edge from `yc_deals`
- finding a path from `yc_home` to `yc_deals`
- replaying a multi-step chain from `yc_home` to `yc_deals`
- resolving and replaying a resumed node path from `yc_home` to `yc_www-ycombinator-com-jobs-role-sales-manager`

## Latest Strong Evidence

### Broad YC Run

Command:

```bash
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 3 --max-edges 32 --max-captures 120 --profile default
```

Run:

```text
/Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/explore-2026-05-30t18-46-27-819z
```

Verification after graph cleanup:

```text
ok: true
captureCount: 120
graphNodeCount: 120
graphEdgeCount: 4707
writeRiskEdgeCount: 54
missingArtifactCount: 0
mismatchCount: 0
```

Important fix from this run:

- `/deal` and `/deals` are canonicalized to the `yc_deals` node.
- graph mutation now replaces existing nodes by `nodeId` or `urlShape` and removes stale outgoing edges before upserting current edges.
- this fixed duplicate derived/canonical nodes in `graph-candidate.json`.

### Resume Smoke Run

Initial command:

```bash
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 2 --max-edges 16 --max-captures 20 --profile default --task-id resume-smoke-2026-05-31
```

Resume command:

```bash
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 2 --max-edges 16 --max-captures 35 --profile default --resume /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/resume-smoke-2026-05-31
```

Verification:

```bash
node dist/cli.js verify-exploration-run ycombinator.com /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/resume-smoke-2026-05-31 --write
```

Result:

```text
ok: true
captureCount: 35
graphNodeCount: 35
graphEdgeCount: 1384
writeRiskEdgeCount: 13
missingArtifactCount: 0
mismatchCount: 0
duplicate capture ids: 0
duplicate graph url shapes: 0
failures: 0
```

Resumed captures included:

```text
021-www-ycombinator-com-jobs-role-sales-manager
022-www-ycombinator-com-jobs-role-marketing
023-www-ycombinator-com-jobs-role-support
024-www-ycombinator-com-jobs-role-operations
025-www-ycombinator-com-jobs-role-science
026-www-ycombinator-com-jobs-location-san-francisco
027-www-ycombinator-com-contact
028-www-ycombinator-com-press
029-www-ycombinator-com-security
030-www-ycombinator-com-library-search
031-www-ycombinator-com-faq
032-www-ycombinator-com-blog-jobs
033-www-ycombinator-com-blog-the-yc-ai-student-starter-pack
034-www-ycombinator-com-blog-ycs-newest-visiting-partners
035-www-ycombinator-com-blog-adding-canada-back
```

CLI chain replay from the resumed run:

```bash
node dist/cli.js exploration-chain ycombinator.com /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/resume-smoke-2026-05-31 node:yc_home action:e_b74b55a1f014 action:e_5819c936c6a0 --profile default
```

Result:

```text
deterministic: true
yc_home -> yc_jobs -> yc_www-ycombinator-com-jobs-role-sales-manager
```

## Current Stability Assessment

Current stability is good for bounded YC-style public crawling and deterministic CLI replay.

It is not yet proven for one-hour unattended operation.

Current confidence:

```text
YC public crawler: 7/10
arbitrary logged-in websites: 5/10
one-hour agent autonomy: not certified yet
```

The harness now has the core behaviors an external agent needs:

- durable progress
- resumable run state
- graph artifact verification
- resolved topology for planning and graph-quality checks
- simple local graph visualization
- per-run agent contract
- deterministic node/action/chain replay
- committed capture summaries
- duplicate graph-node prevention
- browser session reuse

The missing proof is a longer soak with injected browser death and recovery.

## Important Files

Core harness:

```text
src/explorer/harness.ts
src/explorer/harness-contracts.ts
src/explorer/post-capture.ts
src/explorer/graph-cli.ts
src/cli.ts
```

YC config:

```text
src/sites/ycombinator.com/config.ts
src/site-config.ts
src/contracts.ts
```

Docs and handoff:

```text
agent-handoff.md
cartographer-live-testing-plan.md
yc-harness-continuation.md
```

## Next Best Work

1. Run a longer YC soak.

```bash
pnpm build
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 3 --max-edges 40 --max-captures 250 --profile default --task-id yc-soak-2026-05-31
```

2. During that run, deliberately kill or close the browser once and confirm the harness reconnects or recovers without corrupting `run.json`.

3. Verify the completed run.

```bash
node dist/cli.js verify-exploration-run ycombinator.com /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31 --write
```

4. Check duplicate IDs and URL shapes.

```bash
jq '[.captures[].captureId] | {captures:length, unique:(unique|length)}' /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31/run.json
jq '[.nodes[].urlShape] | {nodes:length, unique:(unique|length)}' /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31/graph-candidate.json
```

5. For any newly discovered node, test the graph and CLI immediately.

```bash
node dist/cli.js exploration-node ycombinator.com <new-node-id> /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31
node dist/cli.js exploration-path ycombinator.com yc_home <new-node-id> /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31
node dist/cli.js exploration-chain ycombinator.com /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31 node:yc_home action:<edge-1> action:<edge-2> --profile default
```

6. If the soak exposes failures, improve the harness before expanding scope:

- add missing YC surface classifiers
- strengthen URL canonicalization
- improve duplicate-node reconciliation
- improve transient browser/page recovery
- improve progress/resume artifacts
- improve CLI output if an external agent would not know what to do next

## 2026-05-31 Soak Update

Run directory:

```text
/Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31
```

Commands run:

```bash
pnpm build
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 3 --max-edges 40 --max-captures 250 --profile default --task-id yc-soak-2026-05-31
node dist/cli.js explore-harness ycombinator.com --goal yc_home --max-depth 3 --max-edges 40 --max-captures 250 --profile default --resume /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31
```

Injected browser-death evidence:

- First kill of the YC browser process exposed a generic stale-CDP race: `connectOverCDP` could fail with `ECONNREFUSED` after the liveness probe but before attach.
- Generic fix: `connectOrStartTaskBrowser` now discards the stale browser-session record and starts a new browser when CDP attach fails after a positive liveness check.
- Generic fix: crawl retry classification now treats `ERR_ABORTED`, `ECONNREFUSED`, and frame-detach navigation failures as retryable.
- Second kill after the fix recovered in-process: the run advanced from committed captures in the 20s to 33+ captures, wrote a fresh `browser-session.json`, and did not add a new failure.
- Resume after the failed pre-fix process also worked: the same run directory continued from committed state and did not corrupt `run.json`.

Final verification:

```text
ok: true
captureCount: 194
graphNodeCount: 193
graphEdgeCount: 7550
writeRiskEdgeCount: 111
missingArtifactCount: 0
mismatchCount: 0
duplicate capture ids: 0
duplicate capture url shapes: 0
duplicate graph url shapes: 0
failures: 0
```

New fixes from this soak:

- Added generic stale-CDP recovery when an existing browser-session record passes liveness but `connectOverCDP` fails.
- Expanded retryable crawl errors to include `ERR_ABORTED`, `ECONNREFUSED`, and frame-detach navigation failures.
- Added stale failure cleanup on resume/successful recapture so resolved failures do not remain in `run.json`.
- Added `yc_content_page` classification for root YC content pages such as `/whynot`.
- Tightened login detection so arbitrary page text mentioning passwords does not classify rich public pages as login unless there is an actual password input/textbox control.

CLI replay evidence:

```bash
node dist/cli.js exploration-path ycombinator.com yc_home yc_www-ycombinator-com-companies-industry-security /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31
node dist/cli.js exploration-chain ycombinator.com /Users/varad/.cartographer/sites/ycombinator.com/exploration-runs/yc-soak-2026-05-31 node:yc_home action:e_551ee4cc9a52 action:e_eb2e4638d57d action:e_efed469706c7 --profile default
```

Result:

```text
deterministic: true
yc_home -> yc_cofounder_matching -> yc_www-ycombinator-com-companies-accessowl -> yc_www-ycombinator-com-companies-industry-security
```

Browser substrate assessment:

- Obscura is not installed on this machine's `PATH`, but its CLI/CDP shape is relevant for a future optional provider.
- Browserbase is managed cloud with a free tier, not a packageable local free browser runtime.
- The near-term default is now Cartographer-owned Playwright browser binaries/profiles rather than the user's normal browser. `CARTOGRAPHER_CHROME_PATH` remains available as an explicit override.
- Optional CDP providers such as Obscura, Lightpanda, Browserless, or Browserbase should sit behind the same browser-provider boundary rather than changing graph/capture/replay code directly.

## Do Not Claim Complete Until

Do not mark the overall goal complete until current evidence proves:

- a deep YC run completes and verifies cleanly
- the graph has no duplicate nodes for the same URL shape
- new nodes can be inspected through CLI
- paths to new nodes can be computed through CLI
- at least one deep multi-step chain replays deterministically
- resume works after partial run termination
- manual browser quit or browser death is handled without losing committed state
- the resulting artifacts are understandable enough for an external agent to continue without chat context
