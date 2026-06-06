import type {
  AcquisitionCandidate,
  AcquisitionObligation,
  CompiledFallbackReview,
  FallbackAcquisitionScorecard,
  FallbackTape,
  TaskAcquisitionScorecard,
  TaskFile,
} from "./contracts.js";

export function fallbackScorecard(input: {
  tape: FallbackTape;
  candidates: AcquisitionCandidate[];
  obligations: AcquisitionObligation[];
}): FallbackAcquisitionScorecard {
  const highValueCandidateCount = input.candidates.filter(
    (candidate) => candidate.harnessEasyToPromote === "high",
  ).length;
  const dataOutputCandidateCount = input.candidates.filter(
    (candidate) => candidate.kind === "read_output",
  ).length;
  const writeCandidateCount = input.candidates.filter(
    (candidate) =>
      candidate.kind === "write_command" || candidate.kind === "repair",
  ).length;
  const blockerCount = input.obligations.filter(
    (obligation) => obligation.severity === "blocker",
  ).length;
  const easyToPromote =
    highValueCandidateCount > 0
      ? "high"
      : input.candidates.some(
            (candidate) => candidate.harnessEasyToPromote === "medium",
          )
        ? "medium"
        : "low";
  const acquisitionQuality =
    blockerCount > 0
      ? "thin"
      : highValueCandidateCount > 0
        ? "acceptable"
        : input.candidates.length > 0
          ? "thin"
          : "poor";
  return {
    easyToPromote,
    acquisitionQuality,
    candidateCount: input.candidates.length,
    highValueCandidateCount,
    obligationCount: input.obligations.length,
    blockerCount,
    dataOutputCandidateCount,
    writeCandidateCount,
    reasoning: scoreReason({
      candidates: input.candidates.length,
      highValueCandidateCount,
      blockerCount,
      dataOutputCandidateCount,
      writeCandidateCount,
    }),
  };
}

export function taskScorecard(input: {
  task: TaskFile;
  fallbacks: CompiledFallbackReview[];
  extraObligations?: AcquisitionObligation[];
}): TaskAcquisitionScorecard {
  const promotedCount = input.task.segments.filter(
    (segment) => segment.status === "promoted",
  ).length;
  const rejectedCount = input.task.segments.filter(
    (segment) => segment.status === "rejected",
  ).length;
  const deletedCount = input.task.segments.filter(
    (segment) => segment.status === "deleted",
  ).length;
  const rerecordAppliedCount = input.task.segments.filter(
    (segment) => segment.status === "rerecord_requested",
  ).length;
  const obligations = [
    ...input.fallbacks.flatMap((fallback) => fallback.obligations),
    ...(input.extraObligations || []),
  ];
  const candidates = input.fallbacks.flatMap((fallback) => fallback.candidates);
  const blockerCount = obligations.filter(
    (obligation) => obligation.severity === "blocker",
  ).length;
  const obligationCount = obligations.length;
  const dataUsedWithoutOutputCount = obligations.filter(
    (obligation) => obligation.code === "data_used_without_output_contract",
  ).length;
  const writeCandidatesRejectedOrWeakCount = candidates.filter(
    (candidate) =>
      candidate.kind === "repair" ||
      candidate.riskFlags.includes("weak_write_selectors"),
  ).length;
  const highCandidates = candidates.filter(
    (candidate) => candidate.harnessEasyToPromote === "high",
  ).length;
  const candidateCoverage =
    candidates.length === 0 ? "thin" : obligationCount ? "partial" : "complete";
  const acquisitionQuality =
    blockerCount || dataUsedWithoutOutputCount || obligationCount
      ? "thin"
      : highCandidates >= 2
        ? "strong"
        : highCandidates >= 1
          ? "acceptable"
          : candidates.length
            ? "thin"
            : "poor";
  return {
    executionStatus: input.task.status === "closed" ? "complete" : "incomplete",
    lifecycleStatus: input.task.status,
    promotedCount,
    rejectedCount,
    deletedCount,
    rerecordRecommendedCount:
      rerecordAppliedCount +
      candidates.filter((candidate) =>
        candidate.riskFlags.includes("rerecord_recommended"),
      ).length,
    dataUsedWithoutOutputCount,
    writeCandidatesRejectedOrWeakCount,
    candidateCoverage,
    acquisitionQuality,
    reasoning:
      blockerCount || dataUsedWithoutOutputCount
        ? "Review contains acquisition obligations that require explicit agent disposition."
        : "Review candidates and obligations are covered by the compiled harness summary.",
  };
}

function scoreReason(input: {
  candidates: number;
  highValueCandidateCount: number;
  blockerCount: number;
  dataOutputCandidateCount: number;
  writeCandidateCount: number;
}): string {
  if (input.blockerCount) {
    return "Blocker obligations require explicit review before this fallback is acquisition-clean.";
  }
  if (input.highValueCandidateCount) {
    return "High-value reusable candidates were synthesized from deterministic evidence.";
  }
  if (input.dataOutputCandidateCount || input.writeCandidateCount) {
    return "Read/write candidates exist but require careful review or rerecording.";
  }
  if (input.candidates)
    return "Only low/medium mechanical candidates were found.";
  return "No reusable acquisition candidate was detected.";
}
