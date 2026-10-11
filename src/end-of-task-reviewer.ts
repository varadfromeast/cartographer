import type {
  CartographerLogger,
  Domain,
  EndOfTaskReviewInput,
  EndOfTaskReviewer,
  EndOfTaskReviewResult,
  FallbackReviewer,
  FallbackTapeStore,
} from "./contracts.js";
import { ConsoleCartographerLogger } from "./logger.js";

export class DefaultEndOfTaskReviewer implements EndOfTaskReviewer {
  constructor(
    private readonly fallbackReviewer: FallbackReviewer,
    private readonly fallbackStore: FallbackTapeStore,
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
  ) {}

  async reviewCompletedTask(
    input: EndOfTaskReviewInput,
  ): Promise<EndOfTaskReviewResult> {
    this.logger.log("info", "end_task_review.start", {
      domain: input.domain,
      taskStartedAt: input.taskStartedAt,
    });
    const review = await this.fallbackReviewer.review(input.domain);
    const scopedReview = input.taskStartedAt
      ? {
          ...review,
          unpromotedFallbacks: await filterPacketsCreatedAfter(
            input.domain,
            input.taskStartedAt,
            review.unpromotedFallbacks,
            this.fallbackStore,
          ),
        }
      : review;

    return { review: scopedReview };
  }
}

async function filterPacketsCreatedAfter(
  domain: Domain,
  taskStartedAt: string,
  packets: EndOfTaskReviewResult["review"]["unpromotedFallbacks"],
  fallbackStore: FallbackTapeStore,
): Promise<EndOfTaskReviewResult["review"]["unpromotedFallbacks"]> {
  const startedAtMs = Date.parse(taskStartedAt);
  if (Number.isNaN(startedAtMs))
    throw new Error(`Invalid taskStartedAt: ${taskStartedAt}`);
  const scoped = [];
  for (const packet of packets) {
    const tape = await fallbackStore.load(domain, packet.id);
    if (!tape) continue;
    if (Date.parse(tape.createdAt) >= startedAtMs) scoped.push(packet);
  }
  return scoped;
}
