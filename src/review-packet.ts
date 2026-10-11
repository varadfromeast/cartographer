import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  EvidenceArtifact,
  EvidencePreview,
  FallbackReviewPacket,
  FallbackTape,
  CompiledFallbackReview,
} from "./contracts.js";
import { compileFallbackAcquisitionReview } from "./acquisition-review-compiler.js";
import { createFallbackPromotionSummary } from "./fallback-summary.js";
import {
  fallbackDecisionTemplatePath,
  fallbackDecisionSchemaPath,
  fallbackReviewPath,
  fallbackReviewRequestPath,
} from "./paths.js";
import { ensureDir } from "./fs-json.js";
import { PROMOTION_REVIEW_PROMPT } from "./promotion-review-prompt.js";

export async function createFallbackReviewPacket(
  domain: Domain,
  tape: FallbackTape,
): Promise<FallbackReviewPacket> {
  const evidencePreview = await Promise.all(tape.evidence.map(previewEvidence));
  return {
    id: tape.id,
    domain,
    taskId: tape.taskId,
    taskSegmentId: tape.taskSegmentId,
    taskSegmentPath: tape.taskSegmentPath,
    intent: tape.intent,
    status: tape.status,
    stepCount: tape.steps.length,
    writesToPlatform: tape.writesToPlatform,
    args: tape.args,
    evidence: tape.evidence,
    visualReviews: [
      ...(tape.visualReviews || []),
      ...(tape.operations || [])
        .map((operation) => operation.visualReview)
        .filter((review): review is NonNullable<typeof review> =>
          Boolean(review),
        ),
    ],
    evidencePreview,
    reviewPath: fallbackReviewPath(domain, tape.id),
    reviewRequestPath: fallbackReviewRequestPath(domain, tape.id),
    decisionSchemaPath: fallbackDecisionSchemaPath(domain, tape.id),
    decisionTemplatePath: fallbackDecisionTemplatePath(domain, tape.id),
    createReviewCommand: `node packages/cartographer/dist/cli.js create-promotion-review ${domain} ${tape.id}`,
    applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
  };
}

export async function writeFallbackReviewMarkdown(
  domain: Domain,
  tape: FallbackTape,
): Promise<string> {
  const packet = await createFallbackReviewPacket(domain, tape);
  const acquisition = await compileFallbackAcquisitionReview({ tape });
  const outputPath = fallbackReviewPath(domain, tape.id);
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(
    outputPath,
    renderFallbackReview(packet, tape, acquisition),
    "utf8",
  );
  return outputPath;
}

function renderFallbackReview(
  packet: FallbackReviewPacket,
  tape: FallbackTape,
  acquisition: CompiledFallbackReview,
): string {
  const summary = createFallbackPromotionSummary(tape, packet.evidencePreview);
  const lines = [
    `# Fallback Review: ${packet.id}`,
    "",
    `- Domain: ${packet.domain}`,
    packet.taskId ? `- Task: ${packet.taskId}` : undefined,
    packet.taskSegmentId ? `- Segment: ${packet.taskSegmentId}` : undefined,
    packet.taskSegmentPath
      ? `- Segment file: ${packet.taskSegmentPath}`
      : undefined,
    `- Intent: ${packet.intent}`,
    `- Status: ${packet.status}`,
    `- Writes: ${String(packet.writesToPlatform)}`,
    `- Steps: ${String(packet.stepCount)}`,
    "",
    "## Steps",
    "",
  ].filter((line): line is string => line !== undefined);

  for (const [index, step] of tape.steps.entries()) {
    lines.push(`${index + 1}. ${step.name}`);
    lines.push(`   - Type: ${step.type}`);
    lines.push(`   - Instruction: ${step.instruction}`);
    lines.push(
      `   - Selectors: ${step.actions.map((action) => action.selector).join(", ")}`,
    );
    if (step.validators?.length) {
      lines.push(`   - Validators: ${JSON.stringify(step.validators)}`);
    }
  }

  lines.push("", "## Deterministic Summary", "");
  lines.push(`- Entry URL: ${summary.entryUrl}`);
  lines.push(`- Final URL: ${summary.finalUrl}`);
  if (summary.sessionId) lines.push(`- Session ID: ${summary.sessionId}`);
  if (summary.recordingStartedAt)
    lines.push(`- Recording started: ${summary.recordingStartedAt}`);
  lines.push(`- Operations logged: ${summary.operationCount}`);
  lines.push(
    `- Risk flags: ${summary.mechanicalHints.riskFlags.join(", ") || "none"}`,
  );
  lines.push(
    `- Selector warnings: ${summary.mechanicalHints.selectorWarnings.join(", ") || "none"}`,
  );
  if (summary.mechanicalHints.suggestedPostconditions.length) {
    lines.push("- Suggested postconditions:");
    for (const postcondition of summary.mechanicalHints
      .suggestedPostconditions) {
      lines.push(`  - ${JSON.stringify(postcondition)}`);
    }
  } else {
    lines.push("- Suggested postconditions: none");
  }
  if (summary.mechanicalHints.textEvidenceSelectors.length) {
    lines.push(
      `- Text evidence selectors: ${summary.mechanicalHints.textEvidenceSelectors.join(", ")}`,
    );
  }
  if (summary.visualReviews.length) {
    lines.push("- Visual reviews:");
    for (const review of summary.visualReviews) {
      lines.push(
        `  - ${review.id}: ${review.status}${review.result ? ` verdict=${review.result.verdict}` : ""} screenshot=${review.source.screenshotPath}`,
      );
      lines.push(`    question: ${review.question}`);
    }
  }

  lines.push("", "## Acquisition Scorecard", "");
  lines.push(`- Quality: ${acquisition.scorecard.acquisitionQuality}`);
  lines.push(
    `- Harness easy to promote: ${acquisition.scorecard.easyToPromote}`,
  );
  lines.push(`- Candidates: ${acquisition.scorecard.candidateCount}`);
  lines.push(
    `- High-value candidates: ${acquisition.scorecard.highValueCandidateCount}`,
  );
  lines.push(`- Obligations: ${acquisition.scorecard.obligationCount}`);
  lines.push(`- Reasoning: ${acquisition.scorecard.reasoning}`);

  if (acquisition.obligations.length) {
    lines.push("", "## Acquisition Obligations", "");
    for (const obligation of acquisition.obligations) {
      lines.push(
        `- ${obligation.severity} ${obligation.code}: ${obligation.message}`,
      );
    }
  }

  if (acquisition.candidates.length) {
    lines.push("", "## Acquisition Candidates", "");
    lines.push(
      "| Candidate | Kind | Harness Easy | Suggested Command | Risk | Evidence |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const candidate of acquisition.candidates) {
      lines.push(
        `| ${candidate.id} | ${candidate.kind} | ${candidate.harnessEasyToPromote} | ${candidate.suggestedCommandName || "N/A"} | ${(candidate.riskFlags.join(", ") || "none").replace(/\|/g, "\\|")} | ${candidate.evidencePaths.length ? "yes" : "no"} |`,
      );
    }
  }

  if (summary.operations.length) {
    lines.push("", "## Operation Log", "");
    for (const [index, operation] of summary.operations.entries()) {
      const details = [
        operation.surface ? `surface=${operation.surface}` : undefined,
        operation.promotionEligible === false
          ? "promotionEligible=false"
          : undefined,
        operation.success !== undefined
          ? `success=${operation.success}`
          : undefined,
        operation.selector ? `selector=${operation.selector}` : undefined,
        operation.selectorCandidates?.length
          ? `selectorCandidates=${operation.selectorCandidates.length}`
          : undefined,
        operation.urlAfter ? `after=${operation.urlAfter}` : undefined,
        operation.evidencePath
          ? `evidence=${operation.evidencePath}`
          : undefined,
        operation.evidenceSummaryPath
          ? `summary=${operation.evidenceSummaryPath}`
          : undefined,
        operation.visualReview
          ? `visualReview=${operation.visualReview.id}:${operation.visualReview.status}`
          : undefined,
        operation.stepId ? `step=${operation.stepId.slice(0, 10)}` : undefined,
        operation.writesToPlatform ? "write=true" : undefined,
      ].filter(Boolean);
      lines.push(
        `${index + 1}. ${operation.kind}: ${operation.instruction}${details.length ? ` (${details.join("; ")})` : ""}`,
      );
      if (operation.selectorCandidates?.length) {
        for (const candidate of operation.selectorCandidates) {
          lines.push(
            `   - selector ${candidate.stability}: ${candidate.selector} (${candidate.reason})`,
          );
        }
      }
      if (operation.evidenceSummary?.preview.length) {
        for (const line of operation.evidenceSummary.preview) {
          lines.push(`   - summary: ${line}`);
        }
      }
      if (operation.evidenceSummary?.warnings.length) {
        lines.push(
          `   - evidence warnings: ${operation.evidenceSummary.warnings.join(", ")}`,
        );
      }
      if (operation.writeGrounding) {
        lines.push(
          `   - write grounding: ${operation.writeGrounding.promotionReady ? "promotion-ready" : "rerecord-needed"}${operation.writeGrounding.recommendedSelector ? ` selector=${operation.writeGrounding.recommendedSelector}` : ""}`,
        );
        for (const candidate of operation.writeGrounding.candidates.slice(
          0,
          3,
        )) {
          lines.push(
            `     - score ${candidate.score}: ${candidate.selector} (${candidate.reasons.concat(candidate.penalties).join("; ")})`,
          );
        }
      }
      if (operation.evidencePaths) {
        for (const [label, evidencePath] of Object.entries(
          operation.evidencePaths,
        )) {
          lines.push(`   - evidence ${label}: ${evidencePath}`);
        }
      }
    }
  }

  lines.push("", "## Evidence", "");
  for (const evidence of packet.evidencePreview) {
    lines.push(`### ${evidence.kind}: ${evidence.label}`);
    lines.push("");
    lines.push(`Path: ${evidence.path}`);
    if (evidence.selector) lines.push(`Selector: ${evidence.selector}`);
    if (evidence.preview) {
      lines.push("", "```text", evidence.preview, "```");
    }
    lines.push("");
  }

  lines.push("## Agent Promotion Review", "");
  lines.push(
    "Use this prompt for the reasoning step. Return a PromotionDecision JSON object; do not run promotion commands yourself.",
  );
  lines.push("", "```text", PROMOTION_REVIEW_PROMPT, "```", "");
  if (packet.reviewRequestPath)
    lines.push(`Review request JSON: ${packet.reviewRequestPath}`);
  if (packet.decisionSchemaPath)
    lines.push(`Decision schema JSON: ${packet.decisionSchemaPath}`);
  if (packet.decisionTemplatePath)
    lines.push(`Decision template JSON: ${packet.decisionTemplatePath}`);
  if (packet.applyDecisionCommand) {
    lines.push("", "Apply a completed decision with:");
    lines.push("", "```bash", packet.applyDecisionCommand, "```", "");
  }

  lines.push("## Typed Review Flow", "");
  lines.push(
    "Mutation is only through a decision JSON. Direct promote/reject/delete commands are deprecated because they bypass schema validation, slicing, duplicate review, and stateScope.",
  );
  lines.push("");
  lines.push("Create or refresh review artifacts with:");
  lines.push("");
  lines.push("```bash", packet.createReviewCommand, "```", "");
  if (packet.applyDecisionCommand) {
    lines.push("Apply a completed decision with:");
    lines.push("");
    lines.push("```bash", packet.applyDecisionCommand, "```", "");
  }
  return `${lines.join("\n")}\n`;
}

async function previewEvidence(
  evidence: EvidenceArtifact,
): Promise<EvidencePreview> {
  if (evidence.kind !== "text") {
    return {
      kind: evidence.kind,
      label: evidence.label,
      path: evidence.path,
      selector: evidence.selector,
    };
  }
  const raw = await fs.readFile(evidence.path, "utf8").catch(() => "");
  return {
    kind: evidence.kind,
    label: evidence.label,
    path: evidence.path,
    selector: evidence.selector,
    preview: raw.slice(0, 1000),
  };
}
