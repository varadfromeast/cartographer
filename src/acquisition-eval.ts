import type {
  CompiledFallbackReview,
  FallbackTape,
  FallbackTapeId,
} from "./contracts.js";
import { compileFallbackAcquisitionReview } from "./acquisition-review-compiler.js";

export interface AcquisitionEvalResult {
  fallbackTapeId: FallbackTapeId;
  promotionReady: string[];
  rerecord: string[];
  rejectedByHarness: string[];
  candidateCount: number;
  verdict: "promotion_ready" | "rerecord_required" | "no_reusable_candidate";
  review: CompiledFallbackReview;
}

export async function evaluateFallbackAcquisition(
  tape: FallbackTape,
): Promise<AcquisitionEvalResult> {
  const review = await compileFallbackAcquisitionReview({ tape });
  const promotionReady = review.candidates
    .filter(
      (candidate) =>
        candidate.harnessEasyToPromote !== "low" &&
        !candidate.riskFlags.includes("weak_write_selectors") &&
        !candidate.riskFlags.includes("rerecord_recommended") &&
        Boolean(candidate.suggestedCommandName) &&
        Boolean(candidate.suggestedPostconditions?.length),
    )
    .map((candidate) => candidate.reviewItemId);
  const rerecord = review.candidates
    .filter(
      (candidate) =>
        candidate.kind === "repair" ||
        candidate.riskFlags.includes("weak_write_selectors") ||
        candidate.riskFlags.includes("rerecord_recommended"),
    )
    .map((candidate) => candidate.reviewItemId);
  const rejectedByHarness = review.candidates
    .filter(
      (candidate) =>
        !promotionReady.includes(candidate.reviewItemId) &&
        !rerecord.includes(candidate.reviewItemId),
    )
    .map((candidate) => candidate.reviewItemId);
  return {
    fallbackTapeId: tape.id,
    promotionReady,
    rerecord,
    rejectedByHarness,
    candidateCount: review.candidates.length,
    verdict: promotionReady.length
      ? "promotion_ready"
      : rerecord.length
        ? "rerecord_required"
        : "no_reusable_candidate",
    review,
  };
}
