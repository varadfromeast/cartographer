import type {
  Domain,
  EvidenceArtifact,
  FallbackOperation,
  FallbackTape,
  SelectorDiagnosticCandidate,
  State,
  TaskId,
  TaskSegmentFile,
} from "./contracts.js";
import { JsonFallbackTapeStore } from "./fallback-store.js";
import { readJsonFile } from "./fs-json.js";
import { sha256 } from "./hash.js";
import {
  selectorCandidatesForSnapshotRef,
  type SnapshotRefEvidence,
} from "./playwright-cli-evidence.js";
import { readSegmentOperations } from "./segment-journal.js";
import { JsonTaskStore } from "./task-store.js";

export async function materializeRecordingSegments(input: {
  domain: Domain;
  taskId: TaskId;
  taskStore?: JsonTaskStore;
  fallbackStore?: JsonFallbackTapeStore;
  abandonEmptyReason?: string;
}): Promise<{
  materialized: Array<{ segmentId: string; fallbackTapeId: string }>;
  abandoned: Array<{ segmentId: string; reason: string }>;
}> {
  const taskStore = input.taskStore || new JsonTaskStore();
  const fallbackStore = input.fallbackStore || new JsonFallbackTapeStore();
  const segments = await taskStore.segmentsForTask(input.domain, input.taskId);
  const materialized: Array<{ segmentId: string; fallbackTapeId: string }> = [];
  const abandoned: Array<{ segmentId: string; reason: string }> = [];
  for (const segment of segments.filter(
    (item) => item.status === "recording",
  )) {
    const operations = await readSegmentOperations(segment.eventJournalPath);
    if (!operations.length) {
      if (input.abandonEmptyReason) {
        await taskStore.markSegmentStatus({
          domain: input.domain,
          taskId: input.taskId,
          segmentId: segment.segmentId,
          status: "abandoned",
          reason: input.abandonEmptyReason,
        });
        abandoned.push({
          segmentId: segment.segmentId,
          reason: input.abandonEmptyReason,
        });
      }
      continue;
    }
    const tape = await createTapeFromSegment(input.domain, segment, operations);
    await fallbackStore.save(tape);
    await taskStore.attachFallbackTape({
      domain: input.domain,
      taskId: input.taskId,
      segmentId: segment.segmentId,
      tape,
    });
    materialized.push({
      segmentId: segment.segmentId,
      fallbackTapeId: tape.id,
    });
  }
  return { materialized, abandoned };
}

async function createTapeFromSegment(
  domain: Domain,
  segment: TaskSegmentFile,
  operations: FallbackOperation[],
): Promise<FallbackTape> {
  const now = new Date().toISOString();
  const sorted = await enrichOperationsWithPreviousSnapshotRefs(
    [...operations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  const entry = stateFromOperation(domain, sorted[0], "fallback-entry");
  const evidence = evidenceFromOperations(sorted);
  return {
    id: sha256({
      domain,
      taskId: segment.taskId,
      segmentId: segment.segmentId,
      operationIds: sorted.map((operation) => operation.id),
      createdAt: now,
    }),
    domain,
    taskId: segment.taskId,
    taskSegmentId: segment.segmentId,
    taskSegmentPath: segment.segmentPath,
    intent: segment.intent,
    source: "playwright_fallback",
    status: "succeeded",
    entry,
    steps: [],
    operations: sorted,
    evidence,
    args: [],
    writesToPlatform: sorted.some((operation) => operation.writesToPlatform),
    recordingStartedAt: segment.createdAt,
    createdAt: now,
    completedAt: now,
  };
}

async function enrichOperationsWithPreviousSnapshotRefs(
  operations: FallbackOperation[],
): Promise<FallbackOperation[]> {
  let previousRefs: SnapshotRefEvidence[] = [];
  const enriched: FallbackOperation[] = [];
  for (const operation of operations) {
    let next = operation;
    const ref = operation.selector?.match(/^(?:aria-ref=)?([a-z]?\d+)$/i)?.[1];
    if (ref && !hasDurableSelectorCandidate(operation.selectorCandidates)) {
      const target = previousRefs.find(
        (item) => item.ref.toLowerCase() === ref.toLowerCase(),
      );
      if (target) {
        const candidates = selectorCandidatesForSnapshotRef(target);
        next = {
          ...operation,
          selector: bestSelector(operation.selector, candidates),
          selectorKind: candidates[0]?.selectorKind || operation.selectorKind,
          selectorCandidates: [
            ...candidates,
            ...(operation.selectorCandidates || []),
          ],
          evidenceSummary: operation.evidenceSummary
            ? {
                ...operation.evidenceSummary,
                target: {
                  ...operation.evidenceSummary.target,
                  ref: target.ref,
                  role: target.role,
                  name: target.name,
                  href: target.href,
                },
                selectorCandidates: [
                  ...candidates,
                  ...(operation.evidenceSummary.selectorCandidates || []),
                ],
                warnings: operation.evidenceSummary.warnings.filter(
                  (warning) => warning !== "snapshot_ref_not_resolved",
                ),
              }
            : operation.evidenceSummary,
        };
      }
    }
    enriched.push(next);
    const refsPath = operation.evidencePaths?.refs;
    if (refsPath) {
      previousRefs =
        (await readJsonFile<SnapshotRefEvidence[]>(refsPath)) || [];
    }
  }
  return enriched;
}

function hasDurableSelectorCandidate(
  candidates?: SelectorDiagnosticCandidate[],
): boolean {
  return Boolean(
    candidates?.some(
      (candidate) =>
        candidate.stability === "strong" || candidate.stability === "medium",
    ),
  );
}

function bestSelector(
  rawSelector: string | undefined,
  candidates: SelectorDiagnosticCandidate[],
): string {
  return (
    candidates.find((candidate) => candidate.stability === "strong")
      ?.selector ||
    candidates.find((candidate) => candidate.stability === "medium")
      ?.selector ||
    rawSelector ||
    candidates[0]?.selector ||
    ""
  );
}

function stateFromOperation(
  domain: Domain,
  operation: FallbackOperation | undefined,
  label: string,
): State {
  const url = operation?.urlBefore || operation?.urlAfter || "";
  const id = sha256({ domain, label, url, operationId: operation?.id });
  return {
    id,
    domain,
    url,
    kind: "unknown",
    fingerprint: {
      hash: id,
      atomIds: [],
      urlShape: url,
      atomCount: 0,
    },
    atoms: [],
    observedAt: operation?.createdAt || new Date().toISOString(),
    evidencePath: operation?.evidencePath,
  };
}

function evidenceFromOperations(
  operations: FallbackOperation[],
): EvidenceArtifact[] {
  const evidence: EvidenceArtifact[] = [];
  for (const operation of operations) {
    for (const [label, filePath] of Object.entries(
      operation.evidencePaths || {},
    )) {
      evidence.push({
        kind: "text",
        label: `${operation.command || operation.kind} ${label}`,
        path: filePath,
        selector: operation.selector,
        createdAt: operation.createdAt,
      });
    }
    if (
      operation.evidencePath &&
      !evidence.some((item) => item.path === operation.evidencePath)
    ) {
      evidence.push({
        kind: "text",
        label: `${operation.command || operation.kind} evidence`,
        path: operation.evidencePath,
        selector: operation.selector,
        createdAt: operation.createdAt,
      });
    }
  }
  return evidence;
}
