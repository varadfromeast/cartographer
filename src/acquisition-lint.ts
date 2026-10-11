import type {
  AcquisitionCandidate,
  AcquisitionObligation,
  EvidenceDigest,
  FallbackTape,
} from "./contracts.js";

export function acquisitionObligations(input: {
  tape: FallbackTape;
  evidenceDigest: EvidenceDigest;
  candidates: AcquisitionCandidate[];
  taskIntent?: string;
}): AcquisitionObligation[] {
  const obligations: AcquisitionObligation[] = [];
  const add = (obligation: Omit<AcquisitionObligation, "id">) => {
    obligations.push({
      id: `${input.tape.id}:obligation-${String(obligations.length + 1).padStart(2, "0")}`,
      ...obligation,
    });
  };

  const readCandidates = input.candidates.filter(
    (candidate) => candidate.kind === "read_output",
  );
  const writeCandidates = input.candidates.filter(
    (candidate) =>
      candidate.kind === "write_command" || candidate.kind === "repair",
  );
  const followerPattern = input.evidenceDigest.repeatedTextPatterns.find(
    (pattern) => pattern.name === "follower_count_text",
  );

  if (
    input.evidenceDigest.finalOutputProvenance.length &&
    readCandidates.length
  ) {
    add({
      severity: "blocker",
      code: "data_used_without_output_contract",
      message:
        "Final written output includes data copied from fallback evidence, but review must explicitly promote, reject, or rerecord a read/output command for that data.",
      evidencePaths: unique(
        input.evidenceDigest.finalOutputProvenance
          .flatMap((item) => [
            item.destinationEvidencePath,
            ...item.sourceEvidencePaths,
          ])
          .filter((path): path is string => Boolean(path)),
      ),
      relatedCandidateIds: readCandidates.map((candidate) => candidate.id),
      requiredDisposition: "promote_or_reject",
    });
  }

  if (followerPattern && followerPattern.count >= 2 && readCandidates.length) {
    add({
      severity: "warning",
      code: "repeated_snapshot_scrape",
      message:
        "Multiple evidence snapshots contain follower-count text. Review should handle the read/output candidate before rejecting the surrounding fallback.",
      evidencePaths: followerPattern.evidencePaths,
      relatedCandidateIds: readCandidates.map((candidate) => candidate.id),
      requiredDisposition: "promote_or_reject",
    });
  }

  if (
    /\b(follower|followers|count|above|below|between|profile)\b/i.test(
      input.taskIntent || input.tape.intent,
    ) &&
    followerPattern &&
    readCandidates.length
  ) {
    add({
      severity: "warning",
      code: "task_metric_without_read_candidate",
      message:
        "The task intent depends on profile metrics and follower-count evidence was observed. The read candidate needs an explicit disposition.",
      evidencePaths: followerPattern.evidencePaths,
      relatedCandidateIds: readCandidates.map((candidate) => candidate.id),
      requiredDisposition: "promote_or_reject",
    });
  }

  const weakWrites = writeCandidates.filter((candidate) =>
    candidate.riskFlags.includes("weak_write_selectors"),
  );
  if (weakWrites.length) {
    add({
      severity: "warning",
      code: "weak_write_selectors",
      message:
        "A write action succeeded with weak selectors. Review should promote only with durable selectors, or return a rerecord/reject disposition.",
      evidencePaths: unique(
        weakWrites.flatMap((candidate) => candidate.evidencePaths),
      ),
      relatedCandidateIds: weakWrites.map((candidate) => candidate.id),
      requiredDisposition: "rerecord_or_reject",
    });
  } else if (input.tape.writesToPlatform && !writeCandidates.length) {
    add({
      severity: "warning",
      code: "write_action_without_promotable_candidate",
      message:
        "The fallback wrote to the platform but no write command candidate was synthesized. The review should explain why the write is not promotable.",
      evidencePaths: [],
      relatedCandidateIds: [],
      requiredDisposition: "acknowledge",
    });
  }

  return obligations;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
