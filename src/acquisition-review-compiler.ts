import type {
  AcquisitionObligation,
  CompiledFallbackReview,
  CompiledTaskReview,
  Domain,
  FallbackTape,
  ProcessTapeSummary,
  TaskFile,
  TaskId,
} from "./contracts.js";
import {
  acquisitionCandidates,
  operationDigest,
} from "./acquisition-candidates.js";
import { acquisitionObligations } from "./acquisition-lint.js";
import { createEvidenceDigest } from "./evidence-digest.js";
import { fallbackScorecard, taskScorecard } from "./review-scorecard.js";
import { TASK_PROMOTION_REVIEW_PROMPT } from "./promotion-review-prompt.js";

export interface CompileTaskReviewInput {
  domain: Domain;
  task: TaskFile;
  taskId: TaskId;
  existingCommands: ProcessTapeSummary[];
  tapes: FallbackTape[];
}

export async function compileTaskAcquisitionReview(
  input: CompileTaskReviewInput,
): Promise<CompiledTaskReview> {
  const fallbacks: CompiledFallbackReview[] = [];
  for (const tape of input.tapes) {
    fallbacks.push(
      await compileFallbackAcquisitionReview({
        tape,
        taskIntent: input.task.intent,
      }),
    );
  }
  const taskLevelObligations = taskObligations(input.taskId, fallbacks);
  return {
    schemaVersion: 1,
    domain: input.domain,
    taskId: input.taskId,
    taskIntent: input.task.intent,
    existingCommands: input.existingCommands,
    scorecard: taskScorecard({
      task: input.task,
      fallbacks,
      extraObligations: taskLevelObligations,
    }),
    obligations: [
      ...fallbacks.flatMap((fallback) => fallback.obligations),
      ...taskLevelObligations,
    ],
    fallbacks,
    prompt: TASK_PROMOTION_REVIEW_PROMPT,
  };
}

export async function compileFallbackAcquisitionReview(input: {
  tape: FallbackTape;
  taskIntent?: string;
}): Promise<CompiledFallbackReview> {
  const evidenceDigest = await createEvidenceDigest(input.tape);
  const candidates = acquisitionCandidates({
    tape: input.tape,
    evidenceDigest,
  });
  const obligations = acquisitionObligations({
    tape: input.tape,
    evidenceDigest,
    candidates,
    taskIntent: input.taskIntent,
  });
  return {
    fallbackTapeId: input.tape.id,
    intent: input.tape.intent,
    status: input.tape.status,
    writesToPlatform: input.tape.writesToPlatform,
    operationDigest: operationDigest(input.tape),
    evidenceDigest,
    candidates,
    obligations,
    scorecard: fallbackScorecard({ tape: input.tape, candidates, obligations }),
    deepEvidencePaths: unique(
      candidates.flatMap((candidate) => candidate.evidencePaths),
    ),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function taskObligations(
  taskId: TaskId,
  fallbacks: CompiledFallbackReview[],
): AcquisitionObligation[] {
  const finalOutputEvidence = fallbacks.flatMap(
    (fallback) => fallback.evidenceDigest.finalOutputProvenance,
  );
  if (!finalOutputEvidence.length) return [];
  const readCandidates = fallbacks.flatMap((fallback) =>
    fallback.candidates.filter((candidate) => candidate.kind === "read_output"),
  );
  if (!readCandidates.length) return [];
  const followerOutput = finalOutputEvidence.some((item) =>
    item.matchedPatterns.includes("follower_count_text"),
  );
  if (!followerOutput) return [];
  return [
    {
      id: `${taskId}:obligation-data-output-contract`,
      severity: "blocker",
      code: "data_used_without_output_contract",
      message:
        "Final written output contains follower-count evidence, but the task review must explicitly promote, reject, or rerecord a read/output command that captures that data.",
      evidencePaths: unique(
        finalOutputEvidence
          .flatMap((item) => [
            item.destinationEvidencePath,
            ...item.sourceEvidencePaths,
          ])
          .filter((path): path is string => Boolean(path)),
      ),
      relatedCandidateIds: readCandidates.map((candidate) => candidate.id),
      requiredDisposition: "promote_or_reject",
    },
  ];
}
