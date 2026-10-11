import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Domain } from "../contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../fs-json.js";
import { waitForPageLoginIfNeeded } from "../login-wait.js";
import { siteDir, slugifyName } from "../paths.js";
import { shapeUrl } from "../state-identity.js";
import { withBrowserProfileLock } from "../profile-lock.js";
import {
  closeTaskBrowser,
  connectOrStartTaskBrowser,
} from "../task-browser.js";
import { captureSurface, type SurfaceCapture } from "./surface-capture.js";
import {
  runPostCaptureMethods,
  type CandidateEdgesArtifact,
  type CandidateEdge,
  type PostCaptureArtifacts,
} from "./post-capture.js";
import { getExplorationSiteAdapter } from "./site-adapter.js";
import type { ExplorationSiteAdapter } from "./site-adapter.js";
import type {
  ExplorationHarnessResult,
  HarnessCaptureSummary,
  HarnessCrawlFailure,
  HarnessCrawlPolicy,
  HarnessRunConfig,
} from "./harness-contracts.js";

interface CrawlTarget {
  url: string;
  depth: number;
  parentEdgeId?: string;
  attempts?: number;
}

export async function runExplorationCaptureHarness(
  input: HarnessRunConfig,
): Promise<ExplorationHarnessResult> {
  const resumeRunDir = input.resumeRunDir
    ? await resolveResumeRunDir(input.domain, input.resumeRunDir)
    : undefined;
  const resumeRun = resumeRunDir
    ? await readJsonFile<ExplorationHarnessResult>(path.join(resumeRunDir, "run.json"))
    : undefined;
  const runId =
    resumeRun?.runId ||
    input.taskId ||
    `explore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const maxDepth = Math.max(1, input.maxDepth || 1);
  const maxNavigationEdgesPerSurface = Math.max(
    1,
    input.maxNavigationEdgesPerSurface ||
      getExplorationSiteAdapter(input.domain).defaultMaxNavigationEdgesPerSurface,
  );
  const maxCaptures =
    input.maxCaptures || maxCapturesForDepth(maxDepth, maxNavigationEdgesPerSurface);
  const crawlPolicy: HarnessCrawlPolicy = {
    maxDepth,
    maxNavigationEdgesPerSurface,
    maxCaptures,
    executeClicks: false,
    sameDomainOnly: true,
    followWriteRisk: "none",
  };
  const runDir =
    resumeRunDir ||
    path.join(siteDir(input.domain), "exploration-runs", slugifyName(runId));
  const surfacesDir = path.join(runDir, "surfaces");
  await ensureDir(surfacesDir);

  const profile = input.profile || "default";
  return withBrowserProfileLock(input.domain, profile, async () => {
  let connection = await connectOrStartTaskBrowser(input.domain, runId, profile);
  try {
    const siteAdapter = getExplorationSiteAdapter(input.domain);
    const rootUrl = siteAdapter.resolveGoalUrl(input.goal);
    await connection.page.goto(rootUrl, {
      waitUntil: "domcontentloaded",
    });
    await waitForHarnessLoginIfNeeded(input.domain, connection.page);

    const committedCaptures: HarnessCaptureSummary[] = [
      ...(resumeRun?.captures || []),
    ];
    const visitedUrlShapes = new Set(
      committedCaptures.map((capture) => capture.urlShape),
    );
    const failures: HarnessCrawlFailure[] = (resumeRun?.failures || []).filter(
      (failure) => !visitedUrlShapes.has(failure.urlShape),
    );
    const queued: CrawlTarget[] = resumeRun
      ? await rebuildFrontierFromRun({
          domain: input.domain,
          run: resumeRun,
          maxDepth,
          maxNavigationEdgesPerSurface,
          visitedUrlShapes,
        })
      : [{ url: rootUrl, depth: 0 }];
    let captureIndex = nextCaptureIndex(committedCaptures);
	    await writeProgress(runDir, {
	      runId,
	      domain: input.domain,
	      crawlPolicy,
	      captured: committedCaptures.length,
	      queued: queued.length,
	      visitedUrlShapeCount: visitedUrlShapes.size,
	      currentUrl: rootUrl,
	      failed: failures.length,
	    });
    while (queued.length && committedCaptures.length < maxCaptures) {
      const target = queued.shift();
      if (!target || target.depth > maxDepth) continue;
      const targetShape = shapeUrl(target.url);
      if (visitedUrlShapes.has(targetShape)) {
        continue;
      }
      try {
        await connection.page.goto(target.url, { waitUntil: "domcontentloaded" });
        await waitForHarnessLoginIfNeeded(input.domain, connection.page);
        await waitForSurfaceReady(connection.page);
        const actualUrl = connection.page.url();
        const actualUrlShape = shapeUrl(actualUrl);
        if (!siteAdapter.isCrawlableUrl(actualUrl)) {
          continue;
        }
        if (visitedUrlShapes.has(actualUrlShape)) {
          continue;
        }
        const capture = await captureSurface({
          domain: input.domain,
          runId,
          page: connection.page,
          outputDir: surfacesDir,
          index: captureIndex,
        });
        captureIndex += 1;
        const postCapture = await runPostCaptureMethods({
          domain: input.domain,
          runDir,
          capture,
        });
        if (!postCapture.classification.stable) {
          failures.push(
            crawlFailureFor(
              target,
              new Error(
                `Unstable surface classification: ${postCapture.classification.surfaceType}`,
              ),
            ),
          );
          continue;
        }
        committedCaptures.push(
          captureSummaryFor({
            capture,
            postCapture,
            target,
          }),
        );
        removeResolvedFailures(failures, capture.urlShape);
        visitedUrlShapes.add(capture.urlShape);
        if (target.depth < maxDepth && postCapture.candidateEdges?.edges.length) {
          for (const next of crawlTargetsForEdges({
            domain: input.domain,
            siteAdapter,
            currentUrl: capture.url,
            edges: postCapture.candidateEdges.edges,
            limit: maxNavigationEdgesPerSurface,
          })) {
            if (visitedUrlShapes.has(shapeUrl(next.url))) continue;
            if (queued.some((queuedTarget) => shapeUrl(queuedTarget.url) === shapeUrl(next.url)))
              continue;
            queued.push({
              url: next.url,
              depth: target.depth + 1,
              parentEdgeId: next.parentEdgeId,
            });
          }
        }
        await writeProgress(runDir, {
          runId,
          domain: input.domain,
          crawlPolicy,
          captured: committedCaptures.length,
          queued: queued.length,
          visitedUrlShapeCount: visitedUrlShapes.size,
          currentUrl: capture.url,
          currentDepth: target.depth,
          lastCaptureId: capture.captureId,
          failed: failures.length,
        });
        await writeRunArtifact(runDir, {
          success: true,
          domain: input.domain,
          runId,
          runDir,
          goal: input.goal || resumeRun?.goal,
          crawlPolicy,
          captures: committedCaptures,
          failures,
        });
      } catch (error) {
        const attempts = target.attempts || 0;
        const retryable = isRetryableCrawlError(error);
        if (retryable && attempts < 2) {
          queued.unshift({ ...target, attempts: (target.attempts || 0) + 1 });
          if (isBrowserClosedError(error)) {
            connection = await reconnectHarnessBrowser({
              domain: input.domain,
              runId,
              profile,
              connection,
            });
          } else {
            await refreshHarnessPage(connection);
          }
          await writeProgress(runDir, {
            runId,
            domain: input.domain,
            crawlPolicy,
            captured: committedCaptures.length,
            queued: queued.length,
            visitedUrlShapeCount: visitedUrlShapes.size,
            currentUrl: target.url,
            currentDepth: target.depth,
            failed: failures.length,
            retrying: {
              url: target.url,
              urlShape: shapeUrl(target.url),
              depth: target.depth,
              attempts: attempts + 1,
              error: error instanceof Error ? error.message : String(error),
              retryAt: new Date().toISOString(),
            },
          });
          continue;
        }
        const failure = crawlFailureFor(target, error);
        failures.push(failure);
        await writeProgress(runDir, {
          runId,
          domain: input.domain,
          crawlPolicy,
          captured: committedCaptures.length,
          queued: queued.length,
          visitedUrlShapeCount: visitedUrlShapes.size,
          currentUrl: target.url,
          currentDepth: target.depth,
          failed: failures.length,
          lastFailure: failure,
        });
        await writeRunArtifact(runDir, {
          success: true,
          domain: input.domain,
          runId,
          runDir,
          goal: input.goal || resumeRun?.goal,
          crawlPolicy,
          captures: committedCaptures,
          failures,
        });
      }
    }

    const resultWithoutBrowser = {
      success: true,
      domain: input.domain,
      runId,
      runDir,
      goal: input.goal || resumeRun?.goal,
      crawlPolicy,
      captures: committedCaptures,
      failures,
    };
    await writeRunArtifact(runDir, resultWithoutBrowser);
    const browser = await closeTaskBrowser(input.domain, runId, profile, {
      keepBrowserOpen: true,
    });
    if (!browser.closed) {
      await connection.browser?.close().catch(() => {});
    }
    return { ...resultWithoutBrowser, browser };
  } catch (error) {
    const browser = await closeTaskBrowser(input.domain, runId, profile, {
      keepBrowserOpen: true,
    });
    if (!browser.closed) {
      await connection.browser?.close().catch(() => {});
    }
    throw error;
  }
  });
}

async function waitForSurfaceReady(
  page: Awaited<ReturnType<typeof connectOrStartTaskBrowser>>["page"],
): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText?.trim() || "";
        const interactables = document.querySelectorAll(
          "a[href],button,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[contenteditable='true']",
        ).length;
        return text.length > 40 || interactables > 0;
      },
      undefined,
      { timeout: 15000 },
    )
    .catch(() => {});
}

function crawlTargetsForEdges(input: {
  domain: Domain;
  siteAdapter: ExplorationSiteAdapter;
  currentUrl: string;
  edges: CandidateEdge[];
  limit: number;
}): Array<{ url: string; parentEdgeId: string }> {
  const candidates = input.edges
    .filter((edge) => edge.actionKind === "navigate")
    .filter((edge) => edge.writeRisk === "none")
    .filter((edge) => Boolean(edge.href))
    .sort((a, b) => b.priority - a.priority)
    .map((edge) => ({
      edge,
      url: absoluteSameDomainUrl(input.domain, edge.href || "", input.currentUrl),
    }))
    .filter((entry): entry is { edge: CandidateEdge; url: string } =>
      Boolean(entry.url),
    )
    .filter((entry) => input.siteAdapter.isCrawlableUrl(entry.url))
    .sort((a, b) => input.siteAdapter.routePriority(a.url, a.edge.priority) -
      input.siteAdapter.routePriority(b.url, b.edge.priority))
    .filter(uniqueUrlShape)
    .slice(0, input.limit)
    .map((entry) => ({
      url: entry.url,
      parentEdgeId: entry.edge.edgeId,
    }));
  return candidates;
}

function absoluteSameDomainUrl(
  domain: Domain,
  href: string,
  baseUrl: string,
): string | undefined {
  try {
    const url = new URL(href, baseUrl);
    if (!sameDomain(domain, url.hostname)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sameDomain(domain: Domain, hostname: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function uniqueUrlShape(
  entry: { url: string },
  index: number,
  entries: Array<{ url: string }>,
): boolean {
  const currentShape = shapeUrl(entry.url);
  return entries.findIndex((candidate) => shapeUrl(candidate.url) === currentShape) === index;
}

function maxCapturesForDepth(maxDepth: number, maxNavigationEdgesPerSurface: number): number {
  return Math.max(1, maxDepth + 1) * maxNavigationEdgesPerSurface;
}

async function resolveResumeRunDir(
  domain: Domain,
  resumeRunDir: string,
): Promise<string> {
  if (resumeRunDir !== "latest") return resumeRunDir;
  const runsDir = path.join(siteDir(domain), "exploration-runs");
  const entries = await fs
    .readdir(runsDir, { withFileTypes: true })
    .catch((): Dirent[] => []);
  const latest = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No exploration runs for ${domain}`);
  return latest;
}

async function rebuildFrontierFromRun(input: {
  domain: Domain;
  run: ExplorationHarnessResult;
  maxDepth: number;
  maxNavigationEdgesPerSurface: number;
  visitedUrlShapes: Set<string>;
}): Promise<CrawlTarget[]> {
  const queued: CrawlTarget[] = [];
  const queuedShapes = new Set<string>();
  const siteAdapter = getExplorationSiteAdapter(input.domain);
  for (const capture of input.run.captures) {
    if (capture.depth >= input.maxDepth || !capture.candidateEdgesPath) continue;
    const candidateEdges = await readJsonFile<CandidateEdgesArtifact>(
      capture.candidateEdgesPath,
    );
    if (!candidateEdges?.edges.length) continue;
    for (const next of crawlTargetsForEdges({
      domain: input.domain,
      siteAdapter,
      currentUrl: capture.url,
      edges: candidateEdges.edges,
      limit: input.maxNavigationEdgesPerSurface,
    })) {
      const nextShape = shapeUrl(next.url);
      if (input.visitedUrlShapes.has(nextShape) || queuedShapes.has(nextShape))
        continue;
      queuedShapes.add(nextShape);
      queued.push({
        url: next.url,
        depth: capture.depth + 1,
        parentEdgeId: next.parentEdgeId,
      });
    }
  }
  return queued;
}

function nextCaptureIndex(captures: HarnessCaptureSummary[]): number {
  const maxExisting = captures.reduce((max, capture) => {
    const match = capture.captureId.match(/^(\d+)-/);
    const index = match ? Number(match[1]) : 0;
    return Number.isFinite(index) && index > max ? index : max;
  }, 0);
  return maxExisting + 1;
}

function captureSummaryFor(input: {
  capture: SurfaceCapture;
  postCapture: PostCaptureArtifacts;
  target: CrawlTarget;
}): HarnessCaptureSummary {
  return {
    captureId: input.capture.captureId,
    surfaceJsonPath: path.join(input.capture.artifactDir, "surface.json"),
    markdownPath: input.capture.markdown.path,
    screenshotPath: input.capture.screenshot.path,
    screenshotOverlayPath: input.capture.screenshot.overlayPath,
    classificationPath: input.postCapture.classification.artifactPath,
    nodeMatchPath: input.postCapture.nodeMatch?.artifactPath,
    controlDiffPath: input.postCapture.controlDiff?.artifactPath,
    candidateEdgesPath: input.postCapture.candidateEdges?.artifactPath,
    edgeReconciliationPath: input.postCapture.edgeReconciliation?.artifactPath,
    graphMutationPath: input.postCapture.graphMutation?.artifactPath,
    controlCount: input.capture.controls.length,
    controlGroupCount: input.capture.controlGroups.length,
    candidateEdgeCount: input.postCapture.candidateEdges?.edgeCount,
    url: input.capture.url,
    urlShape: input.capture.urlShape,
    surfaceType: input.postCapture.classification.surfaceType,
    depth: input.target.depth,
    parentEdgeId: input.target.parentEdgeId,
    warnings: input.capture.warnings,
  };
}

async function writeRunArtifact(
  runDir: string,
  run: Omit<ExplorationHarnessResult, "browser">,
): Promise<void> {
  await writeJsonFile(path.join(runDir, "run.json"), run);
}

async function waitForHarnessLoginIfNeeded(
  domain: Domain,
  page: Awaited<ReturnType<typeof connectOrStartTaskBrowser>>["page"],
): Promise<void> {
  if (domain === "ycombinator.com") return;
  await waitForPageLoginIfNeeded(page, `${domain} login screen detected`);
}

function crawlFailureFor(
  target: CrawlTarget,
  error: unknown,
): HarnessCrawlFailure {
  return {
    url: target.url,
    urlShape: shapeUrl(target.url),
    depth: target.depth,
    parentEdgeId: target.parentEdgeId,
    attempts: (target.attempts || 0) + 1,
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  };
}

function removeResolvedFailures(
  failures: HarnessCrawlFailure[],
  urlShape: string,
): void {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    if (failures[index]?.urlShape === urlShape) failures.splice(index, 1);
  }
}

function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(
    message,
  );
}

function isRetryableCrawlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isBrowserClosedError(error) ||
    /interrupted by another navigation|ERR_ABORTED|ERR_NETWORK_CHANGED|ECONNREFUSED|frame was detached|Timeout \d+ms exceeded/i.test(
      message,
    )
  );
}

async function reconnectHarnessBrowser(input: {
  domain: Domain;
  runId: string;
  profile: string;
  connection: Awaited<ReturnType<typeof connectOrStartTaskBrowser>>;
}): Promise<Awaited<ReturnType<typeof connectOrStartTaskBrowser>>> {
  await input.connection.browser?.close().catch(() => {});
  return connectOrStartTaskBrowser(input.domain, input.runId, input.profile);
}

async function refreshHarnessPage(
  connection: Awaited<ReturnType<typeof connectOrStartTaskBrowser>>,
): Promise<void> {
  await connection.page.evaluate(() => window.stop()).catch(() => {});
  await connection.page.close().catch(() => {});
  connection.page = await connection.context.newPage();
}

async function writeProgress(
  runDir: string,
  progress: {
    runId: string;
    domain: Domain;
    crawlPolicy: HarnessCrawlPolicy;
    captured: number;
    queued: number;
    visitedUrlShapeCount: number;
    currentUrl?: string;
    currentDepth?: number;
    lastCaptureId?: string;
    failed?: number;
    lastFailure?: HarnessCrawlFailure;
    retrying?: {
      url: string;
      urlShape: string;
      depth: number;
      attempts: number;
      error: string;
      retryAt: string;
    };
  },
): Promise<void> {
  await writeJsonFile(path.join(runDir, "progress.json"), {
    schemaVersion: 1,
    ...progress,
    updatedAt: new Date().toISOString(),
  });
}
