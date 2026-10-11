import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  FallbackOperation,
  FallbackTape,
  FallbackTapeStore,
  IndexedFallbackOperation,
  ProcessTapeSummary,
  TapeStore,
  TaskId,
  TaskPromotionReviewArtifacts,
  TaskPromotionReviewRequest,
} from "./contracts.js";
import { compileTaskAcquisitionReview } from "./acquisition-review-compiler.js";
import { findDuplicateCandidates } from "./duplicate-candidates.js";
import { ensureDir, writeJsonFile } from "./fs-json.js";
import { createFallbackPromotionSummary } from "./fallback-summary.js";
import { candidateSlices } from "./slice-candidates.js";
import {
  PROMOTION_POLICY_ADVISORY_RULES,
  PROMOTION_POLICY_HARD_RULES,
  TASK_PROMOTION_REVIEW_PROMPT,
} from "./promotion-review-prompt.js";
import {
  createPromotionBatchDecisionSchema,
  createPromotionBatchDecisionTemplate,
  createPromotionReviewArtifacts,
} from "./promotion-decision.js";
import {
  fallbackReviewPath,
  fallbackReviewRequestPath,
  taskPromotionDecisionSchemaPath,
  taskPromotionDecisionTemplatePath,
  taskPromotionReviewPath,
  taskPromotionReviewRequestPath,
} from "./paths.js";
import { JsonTaskStore } from "./task-store.js";

export async function createTaskPromotionReviewArtifacts(input: {
  domain: Domain;
  taskId: TaskId;
  taskStore: JsonTaskStore;
  fallbackStore: FallbackTapeStore;
  tapeStore: TapeStore;
}): Promise<TaskPromotionReviewArtifacts> {
  const task = await input.taskStore.loadTask(input.domain, input.taskId);
  if (!task) throw new Error(`Unknown task: ${input.taskId}`);
  const segments = await input.taskStore.segmentsForTask(
    input.domain,
    input.taskId,
  );
  const openSegments = segments.filter(
    (segment) => segment.status === "recording",
  );
  if (openSegments.length) {
    throw new Error(
      `Task has ${openSegments.length} recording segment(s). Save or abandon them before review-task.`,
    );
  }

  const catalog = await input.tapeStore.loadCatalog(input.domain);
  const existingCommands = Object.values(catalog?.processes || {}).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const tapes = [];
  for (const segment of segments) {
    if (!segment.fallbackTapeId) continue;
    const tape = await input.fallbackStore.load(
      input.domain,
      segment.fallbackTapeId,
    );
    if (!tape) continue;
    await createPromotionReviewArtifacts({
      domain: input.domain,
      fallbackTapeId: tape.id,
      fallbackStore: input.fallbackStore,
      tapeStore: input.tapeStore,
    });
    tapes.push(tape);
  }

  const acquisition = await compileTaskAcquisitionReview({
    domain: input.domain,
    task,
    taskId: input.taskId,
    existingCommands,
    tapes,
  });
  const fallbackItems = tapes.map((tape) =>
    taskFallbackReviewItem(tape, existingCommands, acquisition),
  );
  const request: TaskPromotionReviewRequest = {
    schemaVersion: 1,
    domain: input.domain,
    taskId: input.taskId,
    prompt: TASK_PROMOTION_REVIEW_PROMPT,
    decisionSchemaPath: taskPromotionDecisionSchemaPath(
      input.domain,
      input.taskId,
    ),
    decisionTemplatePath: taskPromotionDecisionTemplatePath(
      input.domain,
      input.taskId,
    ),
    reviewRequestPath: taskPromotionReviewRequestPath(
      input.domain,
      input.taskId,
    ),
    reviewPath: taskPromotionReviewPath(input.domain, input.taskId),
    existingCommands,
    fallbacks: fallbackItems,
    acquisition,
    policy: {
      name: "v1",
      hardRules: PROMOTION_POLICY_HARD_RULES,
      advisoryRules: PROMOTION_POLICY_ADVISORY_RULES,
    },
  };
  const decisionSchema = createPromotionBatchDecisionSchema();
  const decisionTemplate = createPromotionBatchDecisionTemplate({
    taskId: input.taskId,
    fallbacks: fallbackItems,
    existingCommandNames: existingCommands.map((command) => command.name),
  });

  await ensureDir(path.dirname(request.reviewPath));
  await writeJsonFile(request.reviewRequestPath, request);
  await writeJsonFile(request.decisionSchemaPath, decisionSchema);
  await writeJsonFile(request.decisionTemplatePath, decisionTemplate);
  await fs.writeFile(request.reviewPath, renderTaskReview(request), "utf8");
  await input.taskStore.markReviewCreated({
    domain: input.domain,
    taskId: input.taskId,
    reviewPath: request.reviewPath,
    reviewRequestPath: request.reviewRequestPath,
    decisionSchemaPath: request.decisionSchemaPath,
    decisionTemplatePath: request.decisionTemplatePath,
    coversFallbackTapeIds: tapes.map((tape) => tape.id),
  });

  return {
    reviewPath: request.reviewPath,
    reviewRequestPath: request.reviewRequestPath,
    decisionSchemaPath: request.decisionSchemaPath,
    decisionTemplatePath: request.decisionTemplatePath,
    request,
    decisionSchema,
    decisionTemplate,
  };
}

function taskFallbackReviewItem(
  tape: FallbackTape,
  existingCommands: ProcessTapeSummary[],
  acquisition: TaskPromotionReviewRequest["acquisition"],
): TaskPromotionReviewRequest["fallbacks"][number] {
  const evidencePreview = tape.evidence.map((evidence) => ({
    kind: evidence.kind,
    label: evidence.label,
    path: evidence.path,
    selector: evidence.selector,
  }));
  const summary = createFallbackPromotionSummary(tape, evidencePreview);
  return {
    fallbackTapeId: tape.id,
    taskSegmentId: tape.taskSegmentId,
    taskSegmentPath: tape.taskSegmentPath,
    intent: tape.intent,
    status: tape.status,
    writesToPlatform: tape.writesToPlatform,
    args: tape.args,
    operations: indexedOperations(tape.operations || []),
    candidateSlices: candidateSlices(tape),
    reviewRequestPath: fallbackReviewRequestPath(tape.domain, tape.id),
    reviewPath: fallbackReviewPath(tape.domain, tape.id),
    duplicateCandidates: findDuplicateCandidates(tape, existingCommands),
    riskFlags: summary.mechanicalHints.riskFlags,
    acquisition: acquisition?.fallbacks.find(
      (fallback) => fallback.fallbackTapeId === tape.id,
    ),
  };
}

function indexedOperations(
  operations: FallbackOperation[],
): IndexedFallbackOperation[] {
  return operations.map((operation, operationIndex) => ({
    ...operation,
    operationIndex,
  }));
}

function renderTaskReview(request: TaskPromotionReviewRequest): string {
  const existingCommandNames = new Set(
    request.existingCommands.map((command) => command.name),
  );
  const lines = [
    `# Task Promotion Review: ${request.taskId}`,
    "",
    `- Review request: ${request.reviewRequestPath}`,
    `- Decision schema: ${request.decisionSchemaPath}`,
    `- Decision template: ${request.decisionTemplatePath}`,
    "",
    "## What To Decide",
    "- Promote reusable candidate slices into CLI skills.",
    "- Reject or delete noisy task-specific fallback evidence.",
    "- Raw snapshots are linked evidence, not primary reading material.",
    "",
    "## Promotion Boundary",
    "- Cartographer records Playwright CLI fallback operations and deterministic evidence.",
    "- Candidate slices are mechanical contiguous operation ranges, not semantic commands.",
    "- The reviewing agent owns commandName, description, args, outputs, stateScope, and the promote/reject/delete judgment.",
    "- Do not promote raw snapshot refs directly; use generated locator/selector evidence in the fallback review packet.",
    "",
  ];

  if (request.acquisition) {
    lines.push("## Acquisition Scorecard");
    lines.push("");
    lines.push(
      `- Quality: ${request.acquisition.scorecard.acquisitionQuality}`,
    );
    lines.push(
      `- Candidate coverage: ${request.acquisition.scorecard.candidateCoverage}`,
    );
    lines.push(
      `- Promoted segments: ${request.acquisition.scorecard.promotedCount}`,
    );
    lines.push(
      `- Rejected segments: ${request.acquisition.scorecard.rejectedCount}`,
    );
    lines.push(
      `- Data used without output obligations: ${request.acquisition.scorecard.dataUsedWithoutOutputCount}`,
    );
    lines.push(
      `- Weak write/rerecord candidates: ${request.acquisition.scorecard.writeCandidatesRejectedOrWeakCount}`,
    );
    lines.push(`- Reasoning: ${request.acquisition.scorecard.reasoning}`);
    lines.push("");

    if (request.acquisition.obligations.length) {
      lines.push("## Acquisition Obligations");
      lines.push("");
      for (const obligation of request.acquisition.obligations) {
        lines.push(`### ${obligation.id}`);
        lines.push(`- Severity: ${obligation.severity}`);
        lines.push(`- Code: ${obligation.code}`);
        lines.push(`- Required disposition: ${obligation.requiredDisposition}`);
        lines.push(
          `- Related candidates: ${obligation.relatedCandidateIds.join(", ") || "none"}`,
        );
        lines.push(`- Message: ${obligation.message}`);
        if (obligation.evidencePaths.length) {
          lines.push("- Evidence:");
          for (const evidencePath of obligation.evidencePaths.slice(0, 8)) {
            lines.push(`  - ${evidencePath}`);
          }
        }
        lines.push("");
      }
    }
  }

  for (const fallback of request.fallbacks) {
    lines.push(`## Fallback: ${fallback.fallbackTapeId}`);
    lines.push(`- Intent: ${fallback.intent}`);
    lines.push(`- Writes: ${String(fallback.writesToPlatform)}`);
    lines.push(`- Risk: ${fallback.riskFlags.join(", ") || "none"}`);
    lines.push(`- Review JSON: ${fallback.reviewRequestPath}`);
    lines.push(
      `- Deep review: [${fallback.fallbackTapeId}](${fallback.reviewPath})`,
    );
    if (fallback.duplicateCandidates.length) {
      lines.push(
        `- Duplicate candidates: ${fallback.duplicateCandidates
          .map((candidate) => candidate.processName)
          .join(", ")}`,
      );
    }
    lines.push("");

    lines.push("### Promotion Candidates");
    lines.push(renderCompactCandidateTable(fallback, existingCommandNames));
    lines.push("");

    if (fallback.acquisition?.candidates.length) {
      lines.push("### Acquisition Candidates");
      lines.push(renderAcquisitionCandidateTable(fallback));
      lines.push("");
    }

    lines.push("### Candidate Details");
    if (fallback.acquisition?.obligations.length) {
      lines.push("#### Acquisition obligations");
      for (const obligation of fallback.acquisition.obligations) {
        lines.push(
          `- ${obligation.severity} ${obligation.code}: ${obligation.message}`,
        );
      }
      lines.push("");
    }
    for (const slice of fallback.candidateSlices) {
      lines.push(renderCandidateDetails(fallback, slice, existingCommandNames));
    }

    lines.push("### Operation Index");
    lines.push(renderCompactOperationIndex(fallback));
    lines.push("");
  }

  lines.push("## Apply");
  lines.push("");
  lines.push("After the agent writes a decision JSON, apply it with:");
  lines.push("");
  lines.push(
    "```bash",
    `cg apply-promotion-decision ${domainAlias(request.domain)} --decision-file <decision.json>`,
    "```",
    "",
  );

  return `${lines.join("\n")}\n`;
}

function renderCompactCandidateTable(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
  existingCommandNames: Set<string>,
): string {
  const lines = [
    "| Slice | Kind | Ops | State Transition | Suggested Command | Risk | Evidence |",
    "|---|---|---:|---|---|---|---|",
  ];

  for (const slice of fallback.candidateSlices) {
    const transition = describeSliceTransition(fallback.operations, slice);
    const readyMark = isPromotionReadySlice(slice, existingCommandNames)
      ? "ready"
      : "";
    const risk = slice.riskFlags?.length ? slice.riskFlags.join(", ") : "none";
    const evidence = slice.operationIndexes.some((idx) =>
      Boolean(evidenceLinks(fallback.operations[idx])),
    )
      ? "yes"
      : "no";

    lines.push(
      `| ${slice.id} | ${slice.kind} | ${slice.operationIndexes.length} | ${tableCell(transition || "N/A")} | ${tableCell([slice.suggestedCommandName, readyMark].filter(Boolean).join(" "))} | ${tableCell(risk)} | ${evidence} |`,
    );
  }

  return lines.join("\n");
}

function renderAcquisitionCandidateTable(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
): string {
  const lines = [
    "| Candidate | Kind | Harness Easy | Suggested Command | Required Agent Rating | Risk | Evidence |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const candidate of fallback.acquisition?.candidates || []) {
    lines.push(
      `| ${candidate.id} | ${candidate.kind} | ${candidate.harnessEasyToPromote} | ${candidate.suggestedCommandName || "N/A"} | yes | ${tableCell(candidate.riskFlags.join(", ") || "none")} | ${candidate.evidencePaths.length ? "yes" : "no"} |`,
    );
  }
  return lines.join("\n");
}

function renderCandidateDetails(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
  slice: TaskPromotionReviewRequest["fallbacks"][number]["candidateSlices"][number],
  existingCommandNames: Set<string>,
): string {
  const transition = describeSliceTransition(fallback.operations, slice);
  const lines = [
    `#### ${slice.id}`,
    `- Review item: \`${slice.reviewItemId}\``,
    `- Operations: [${slice.operationIndexes.join(", ")}]`,
    `- State transition: ${transition || "unknown"}`,
    `- Suggested args: ${JSON.stringify(slice.suggestedArgs || [])}`,
    `- Suggested state scope: ${JSON.stringify(slice.suggestedStateScope || null)}`,
    `- Suggested postconditions: ${JSON.stringify(slice.suggestedPostconditions || [])}`,
    `- Suggested command: ${slice.suggestedCommandName || "N/A"}`,
  ];

  if (
    slice.suggestedCommandName &&
    existingCommandNames.has(slice.suggestedCommandName)
  ) {
    lines.push(
      "  - **Warning**: Existing command already uses this name; reject this slice or use the existing CLI command.",
    );
  }

  const selectors = keySelectorsForSlice(fallback, slice);
  if (selectors.length) {
    lines.push("- Key selectors:");
    for (const s of selectors) {
      lines.push(`  - ${s}`);
    }
  }

  const evidence = slice.operationIndexes
    .map((idx) => evidenceLinksForSliceOperation(fallback, idx))
    .filter(Boolean);

  if (evidence.length) {
    lines.push("- Evidence:");
    lines.push(...evidence);
  }

  return lines.join("\n") + "\n";
}

function renderCompactOperationIndex(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
): string {
  const lines = [];
  for (const op of fallback.operations) {
    lines.push(`- ${op.operationIndex}: ${compactOperation(op)}`);
  }
  return lines.join("\n");
}

function compactOperation(operation: IndexedFallbackOperation): string {
  const cmd = operation.command || operation.kind;
  const args = JSON.stringify(operation.commandArgs || []);
  const selector = operation.selector ? ` selector=${operation.selector}` : "";
  const grounding = operation.writeGrounding?.writeAdjacent
    ? ` writeGrounding=${operation.writeGrounding.promotionReady ? "ready" : "rerecord"}`
    : "";
  const surface = operation.surface ? ` [${operation.surface}]` : "";
  return `${cmd} ${args}${selector}${grounding}${surface}`;
}

function evidenceLinks(operation: IndexedFallbackOperation): string {
  if (!operation) return "";
  const parts: string[] = [];
  if (operation.evidenceSummaryPath) {
    parts.push(`summary=${operation.evidenceSummaryPath}`);
  }
  if (operation.evidencePaths) {
    if (
      !parts.some((part) => part.startsWith("summary=")) &&
      operation.evidencePaths["summary"]
    ) {
      parts.push(`summary=${operation.evidencePaths["summary"]}`);
    }
    if (operation.evidencePaths["target"]) {
      parts.push(`target=${operation.evidencePaths["target"]}`);
    }
    if (operation.evidencePaths["writeGrounding"]) {
      parts.push(`writeGrounding=${operation.evidencePaths["writeGrounding"]}`);
    }
    if (operation.evidencePaths["actionDiscovery"]) {
      parts.push(`actionDiscovery=${operation.evidencePaths["actionDiscovery"]}`);
    }
    if (operation.evidencePaths["refs"]) {
      parts.push(`refs=${operation.evidencePaths["refs"]}`);
    }
    if (operation.evidencePaths["snapshot"]) {
      parts.push(`raw=${operation.evidencePaths["snapshot"]}`);
    }
  } else if (operation.evidencePath) {
    parts.push(
      operation.evidencePath.endsWith("snapshot.yaml")
        ? `raw=${operation.evidencePath}`
        : `evidence=${operation.evidencePath}`,
    );
  }

  return parts.join(", ");
}

function evidenceLinksForSliceOperation(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
  operationIndex: number,
): string {
  const operation = fallback.operations[operationIndex];
  if (!operation) return "";
  const parts = evidenceLinks(operation).split(", ").filter(Boolean);
  const snapshot = nearestSnapshotEvidence(fallback.operations, operationIndex);
  if (snapshot?.evidencePaths?.refs) {
    parts.push(`contextRefs=${snapshot.evidencePaths.refs}`);
  }
  if (snapshot?.evidencePaths?.snapshot) {
    parts.push(`contextRaw=${snapshot.evidencePaths.snapshot}`);
  }
  const unique = [...new Set(parts)];
  return unique.length ? `  - op ${operationIndex}: ${unique.join(", ")}` : "";
}

function nearestSnapshotEvidence(
  operations: IndexedFallbackOperation[],
  operationIndex: number,
): IndexedFallbackOperation | undefined {
  return [...operations]
    .filter(
      (operation) =>
        operation.operationIndex <= operationIndex &&
        operation.kind === "snapshot" &&
        (operation.evidencePaths?.refs || operation.evidencePaths?.snapshot),
    )
    .sort((a, b) => b.operationIndex - a.operationIndex)[0];
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function keySelectorsForSlice(
  fallback: TaskPromotionReviewRequest["fallbacks"][number],
  slice: TaskPromotionReviewRequest["fallbacks"][number]["candidateSlices"][number],
): string[] {
  const selectors: string[] = [];
  for (const idx of slice.operationIndexes) {
    const op = fallback.operations[idx];
    if (!op) continue;
    if (op.selector) {
      let line = `op ${idx} selector: ${op.selector}`;
      if (op.selectorCandidates?.length) {
        const top = op.selectorCandidates
          .slice(0, 3)
          .map((c) => `${c.stability} ${c.selectorKind} ${c.selector}`)
          .join("; ");
        line += ` (candidates: ${top})`;
      }
      if (op.evidenceSummary?.warnings.length) {
        line += ` [Warnings: ${op.evidenceSummary.warnings.join(", ")}]`;
      }
      selectors.push(line);
    }
  }
  return selectors;
}

function isPromotionReadySlice(
  slice: TaskPromotionReviewRequest["fallbacks"][number]["candidateSlices"][number],
  existingCommandNames: Set<string>,
): boolean {
  return Boolean(
    slice.suggestedCommandName &&
      !existingCommandNames.has(slice.suggestedCommandName) &&
      slice.suggestedDescription &&
      slice.suggestedPostconditions?.length,
  );
}

function describeSliceTransition(
  operations: IndexedFallbackOperation[],
  slice: TaskPromotionReviewRequest["fallbacks"][number]["candidateSlices"][number],
): string | undefined {
  const first = operations.find(
    (operation) => operation.operationIndex === slice.operationIndexes[0],
  );
  const last = operations.find(
    (operation) =>
      operation.operationIndex ===
      slice.operationIndexes[slice.operationIndexes.length - 1],
  );
  const from = first?.urlBefore || first?.urlAfter;
  const to = last?.urlAfter || last?.urlBefore;
  const parts = [
    from ? `from ${compactReviewUrl(from)}` : undefined,
    to ? `to ${compactReviewUrl(to)}` : undefined,
    slice.suggestedStateScope?.autoEnterProcessName
      ? `auto-enter ${slice.suggestedStateScope.autoEnterProcessName}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("; ") : undefined;
}

function compactReviewUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("instagram.com")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Keep original value.
  }
  return value;
}

function domainAlias(domain: Domain): string {
  return domain === "instagram.com" ? "instagram" : domain;
}
