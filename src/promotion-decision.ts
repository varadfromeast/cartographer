import fs from "node:fs/promises";
import path from "node:path";
import type {
  AcquisitionCandidate,
  CandidateOperationSlice,
  CommandStateScope,
  Domain,
  DuplicateJudgment,
  FallbackTapeId,
  FallbackTapeStore,
  OperationValueBinding,
  Postcondition,
  ProcessOutput,
  ProcessArg,
  ProcessName,
  PromotionBatchDecision,
  PromotionDecision,
  PromotionDecisionApplier,
  PromotionDecisionFile,
  PromotionDecisionApplyResult,
  PromotionDecisionConfidence,
  PromotionDecisionSchema,
  PromotionReviewArtifacts,
  PromotionReviewRequest,
  SkillPromoter,
  TapeStore,
} from "./contracts.js";
import { findDuplicateCandidates } from "./duplicate-candidates.js";
import { createOperationSliceTape } from "./operation-slice.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import {
  fallbackDecisionTemplatePath,
  fallbackDecisionSchemaPath,
  fallbackReviewPath,
  fallbackReviewRequestPath,
} from "./paths.js";
import {
  createFallbackReviewPacket,
  writeFallbackReviewMarkdown,
} from "./review-packet.js";
import { createFallbackPromotionSummary } from "./fallback-summary.js";
import {
  PROMOTION_POLICY_ADVISORY_RULES,
  PROMOTION_POLICY_HARD_RULES,
  PROMOTION_REVIEW_PROMPT,
} from "./promotion-review-prompt.js";
import { compileFallbackAcquisitionReview } from "./acquisition-review-compiler.js";

export async function createPromotionReviewArtifacts(input: {
  domain: Domain;
  fallbackTapeId: FallbackTapeId;
  fallbackStore: FallbackTapeStore;
  tapeStore: TapeStore;
}): Promise<PromotionReviewArtifacts> {
  const tape = await input.fallbackStore.load(
    input.domain,
    input.fallbackTapeId,
  );
  if (!tape) throw new Error(`Unknown fallback tape: ${input.fallbackTapeId}`);
  const catalog = await input.tapeStore.loadCatalog(input.domain);
  const reviewPath = await writeFallbackReviewMarkdown(input.domain, tape);
  const reviewPacket = await createFallbackReviewPacket(input.domain, tape);
  const reviewRequestPath = fallbackReviewRequestPath(input.domain, tape.id);
  const decisionSchemaPath = fallbackDecisionSchemaPath(input.domain, tape.id);
  const decisionTemplatePath = fallbackDecisionTemplatePath(
    input.domain,
    tape.id,
  );
  const fallbackSummary = createFallbackPromotionSummary(
    tape,
    reviewPacket.evidencePreview,
  );
  const acquisition = await compileFallbackAcquisitionReview({ tape });
  const existingCommands = Object.values(catalog?.processes || {}).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const duplicateCandidates = findDuplicateCandidates(tape, existingCommands);
  const request: PromotionReviewRequest = {
    schemaVersion: 1,
    domain: input.domain,
    fallbackTapeId: tape.id,
    prompt: PROMOTION_REVIEW_PROMPT,
    decisionSchemaPath,
    decisionTemplatePath,
    reviewPath,
    reviewPacket,
    fallbackSummary,
    acquisition,
    existingCommands,
    duplicateCandidates,
    policy: {
      name: "v1",
      hardRules: PROMOTION_POLICY_HARD_RULES,
      advisoryRules: PROMOTION_POLICY_ADVISORY_RULES,
    },
  };
  const decisionSchema = createPromotionDecisionSchema();
  const decisionTemplate = createPromotionDecisionTemplate(
    tape.id,
    tape.intent,
    fallbackSummary.mechanicalHints.suggestedPostconditions,
    duplicateCandidates.length > 0,
  );
  await ensureDir(path.dirname(reviewRequestPath));
  await writeJsonFile(reviewRequestPath, request);
  await writeJsonFile(decisionSchemaPath, decisionSchema);
  await writeJsonFile(decisionTemplatePath, decisionTemplate);
  return {
    reviewPath,
    reviewRequestPath,
    decisionSchemaPath,
    decisionTemplatePath,
    request,
    decisionSchema,
    decisionTemplate,
  };
}

export class DefaultPromotionDecisionApplier
  implements PromotionDecisionApplier
{
  constructor(
    private readonly fallbackStore: FallbackTapeStore,
    private readonly skillPromoter: SkillPromoter,
  ) {}

  async apply(
    domain: Domain,
    decision: PromotionDecision,
  ): Promise<PromotionDecisionApplyResult> {
    const normalized = normalizePromotionDecision(decision);
    const tape = await this.fallbackStore.load(
      domain,
      normalized.fallbackTapeId,
    );
    if (!tape)
      throw new Error(`Unknown fallback tape: ${normalized.fallbackTapeId}`);
    if (tape.domain !== domain)
      throw new Error(`Decision domain mismatch for fallback ${tape.id}.`);

    if (normalized.action === "promote") {
      const promotableTape = normalized.operationIndexes?.length
        ? createOperationSliceTape(tape, normalized.operationIndexes, {
            args: normalized.args,
            valueBindings: normalized.valueBindings,
          })
        : tape;
      if (promotableTape.id !== tape.id) {
        await this.fallbackStore.save(promotableTape);
      }
      const promotion = await this.skillPromoter.promote(
        domain,
        promotableTape.id,
        {
          commandName: normalized.commandName,
          description: normalized.description,
          outputs: normalized.outputs,
          stateScope: normalized.stateScope,
          postconditions: normalized.postconditions,
          duplicateJudgment: normalized.duplicateJudgment,
        },
      );
      return {
        decision: normalized,
        agentContractDelta: promotion.agentContractDelta,
        result: {
          action: "promote",
          promotion,
        },
      };
    }

    if (normalized.action === "reject") {
      await this.fallbackStore.reject(
        domain,
        normalized.fallbackTapeId,
        normalized.rejectReason,
      );
      return {
        decision: normalized,
        result: {
          action: "reject",
          rejected: normalized.fallbackTapeId,
          reason: normalized.rejectReason,
        },
      };
    }

    if (normalized.action === "rerecord") {
      await this.fallbackStore.requestRerecord(
        domain,
        normalized.fallbackTapeId,
        {
          reason: normalized.rerecordReason,
          instructions: normalized.rerecordInstructions,
          targetCommandName: normalized.suggestedCommandName,
        },
      );
      return {
        decision: normalized,
        result: {
          action: "rerecord",
          fallbackTapeId: normalized.fallbackTapeId,
          reason: normalized.rerecordReason,
          instructions: normalized.rerecordInstructions,
          suggestedCommandName: normalized.suggestedCommandName,
        },
      };
    }

    await this.fallbackStore.delete(domain, normalized.fallbackTapeId);
    return {
      decision: normalized,
      result: {
        action: "delete",
        deleted: normalized.fallbackTapeId,
      },
    };
  }
}

export async function readPromotionDecisionFile(
  filePath: string,
): Promise<PromotionDecisionFile> {
  const decision = await readJsonFile<unknown>(filePath);
  if (!decision)
    throw new Error(`Decision file not found or empty: ${filePath}`);
  if (isRecord(decision) && decision.action === "review_batch") {
    return normalizePromotionBatchDecision(decision);
  }
  return normalizePromotionDecision(decision);
}

export function normalizePromotionBatchDecision(
  input: unknown,
): PromotionBatchDecision {
  if (!isRecord(input))
    throw new Error("Promotion batch decision must be a JSON object.");
  const action = stringField(input, "action");
  if (action !== "review_batch") {
    throw new Error(`Unsupported batch decision action: ${action}`);
  }
  const decisions = input.decisions;
  if (!Array.isArray(decisions) || !decisions.length) {
    throw new Error("Promotion batch decision requires decisions[].");
  }
  return {
    action,
    taskId: stringField(input, "taskId"),
    reasoning: stringField(input, "reasoning"),
    confidence: confidenceField(input, "confidence"),
    scorecardReview: optionalScorecardReviewField(input, "scorecardReview"),
    obligationDispositions: optionalObligationDispositionsField(
      input,
      "obligationDispositions",
    ),
    decisions: decisions.map(normalizePromotionDecision),
  };
}

export function normalizePromotionDecision(input: unknown): PromotionDecision {
  if (!isRecord(input))
    throw new Error("Promotion decision must be a JSON object.");
  const action = stringField(input, "action");
  const fallbackTapeId = stringField(input, "fallbackTapeId");
  const reviewItemId = optionalStringField(input, "reviewItemId");
  const reasoning = stringField(input, "reasoning");
  const confidence = confidenceField(input, "confidence");

  if (action === "promote") {
    const postconditions = postconditionsField(input, "postconditions");
    if (!postconditions.length)
      throw new Error("Promote decisions require at least one postcondition.");
    return {
      action,
      fallbackTapeId,
      reviewItemId,
      reasoning,
      confidence,
      agentEasyToPromote: optionalEasyToPromoteField(
        input,
        "agentEasyToPromote",
      ),
      commandName: stringField(input, "commandName"),
      description: stringField(input, "description"),
      postconditions,
      outputs: optionalOutputsField(input, "outputs"),
      stateScope: optionalStateScopeField(input, "stateScope"),
      candidateSliceId: optionalStringField(input, "candidateSliceId"),
      operationIndexes: optionalNumberArrayField(input, "operationIndexes"),
      args: optionalProcessArgsField(input, "args"),
      valueBindings: optionalValueBindingsField(input, "valueBindings"),
      duplicateJudgment: optionalDuplicateJudgmentField(
        input,
        "duplicateJudgment",
      ),
    };
  }

  if (action === "reject") {
    return {
      action,
      fallbackTapeId,
      reviewItemId,
      candidateSliceId: optionalStringField(input, "candidateSliceId"),
      operationIndexes: optionalNumberArrayField(input, "operationIndexes"),
      reasoning,
      confidence,
      agentEasyToPromote: optionalEasyToPromoteField(
        input,
        "agentEasyToPromote",
      ),
      rejectReason: stringField(input, "rejectReason"),
      duplicateJudgment: optionalDuplicateJudgmentField(
        input,
        "duplicateJudgment",
      ),
    };
  }

  if (action === "delete") {
    return {
      action,
      fallbackTapeId,
      reviewItemId,
      reasoning,
      confidence,
      agentEasyToPromote: optionalEasyToPromoteField(
        input,
        "agentEasyToPromote",
      ),
    };
  }

  if (action === "rerecord") {
    return {
      action,
      fallbackTapeId,
      reviewItemId,
      candidateSliceId: optionalStringField(input, "candidateSliceId"),
      operationIndexes: optionalNumberArrayField(input, "operationIndexes"),
      reasoning,
      confidence,
      agentEasyToPromote: optionalEasyToPromoteField(
        input,
        "agentEasyToPromote",
      ),
      rerecordReason: stringField(input, "rerecordReason"),
      rerecordInstructions: optionalStringField(input, "rerecordInstructions"),
      suggestedCommandName: optionalStringField(input, "suggestedCommandName"),
    };
  }

  throw new Error(`Unsupported promotion decision action: ${action}`);
}

export function createPromotionDecisionSchema(): PromotionDecisionSchema {
  return {
    schemaVersion: 1,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "fallbackTapeId", "reasoning", "confidence"],
      properties: {
        action: { enum: ["promote", "reject", "delete", "rerecord"] },
        fallbackTapeId: { type: "string", minLength: 1 },
        reviewItemId: { type: "string", minLength: 1 },
        reasoning: { type: "string", minLength: 1 },
        confidence: { enum: ["low", "medium", "high"] },
        agentEasyToPromote: { enum: ["low", "medium", "high"] },
        candidateSliceId: { type: "string", minLength: 1 },
        operationIndexes: {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 0 },
        },
        args: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "required", "description"],
            additionalProperties: false,
            properties: {
              name: { type: "string", pattern: "^[a-z][a-zA-Z0-9_]*$" },
              required: { type: "boolean" },
            description: { type: "string", minLength: 1 },
            transform: {
              type: "object",
              required: ["type"],
              additionalProperties: false,
              properties: {
                type: { enum: ["raw_text", "compact_lines", "notification_rows"] },
                limit: { type: "number", minimum: 1 },
                includePatterns: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                excludePatterns: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
        valueBindings: {
          type: "array",
          items: {
            type: "object",
            required: ["operationIndex", "argName"],
            additionalProperties: false,
            properties: {
              operationIndex: { type: "integer", minimum: 0 },
              argName: { type: "string", pattern: "^[a-z][a-zA-Z0-9_]*$" },
              target: { enum: ["argument", "selector"] },
            },
          },
        },
        commandName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        description: { type: "string", minLength: 1 },
        postconditions: postconditionArraySchema({ minItems: 1 }),
        stateScope: stateScopeSchema(),
        outputs: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "source", "selector", "description"],
            additionalProperties: false,
            properties: {
              name: { type: "string", pattern: "^[a-z][a-zA-Z0-9_]*$" },
              source: { const: "text" },
              selector: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
            },
          },
        },
        duplicateJudgment: {
          type: "object",
          required: ["checked", "duplicateOf", "reasoning"],
          additionalProperties: false,
          properties: {
            checked: { const: true },
            duplicateOf: {
              anyOf: [
                { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
                { type: "null" },
              ],
            },
            reasoning: { type: "string", minLength: 1 },
          },
        },
        rejectReason: { type: "string", minLength: 1 },
        rerecordReason: { type: "string", minLength: 1 },
        rerecordInstructions: { type: "string", minLength: 1 },
        suggestedCommandName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      },
      allOf: [
        {
          if: { properties: { action: { const: "promote" } } },
          then: { required: ["commandName", "description", "postconditions"] },
        },
        {
          if: { properties: { action: { const: "reject" } } },
          then: { required: ["rejectReason"] },
        },
        {
          if: { properties: { action: { const: "rerecord" } } },
          then: { required: ["rerecordReason"] },
        },
      ],
    },
  };
}

function postconditionArraySchema(options: { minItems?: number } = {}) {
  return {
    type: "array",
    ...(options.minItems ? { minItems: options.minItems } : {}),
    items: {
      oneOf: [
        {
          type: "object",
          required: ["type", "value"],
          additionalProperties: false,
          properties: {
            type: { enum: ["url_equals", "url_contains"] },
            value: { type: "string", minLength: 1 },
          },
        },
        {
          type: "object",
          required: ["type", "selector"],
          additionalProperties: false,
          properties: {
            type: { const: "selector_exists" },
            selector: { type: "string", minLength: 1 },
          },
        },
        {
          type: "object",
          required: ["type", "selector", "value"],
          additionalProperties: false,
          properties: {
            type: { enum: ["text_contains", "rendered_text_contains"] },
            selector: { type: "string", minLength: 1 },
            value: { type: "string", minLength: 1 },
            excludeSelectors: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
          },
        },
        {
          type: "object",
          required: ["type", "selectors", "value"],
          additionalProperties: false,
          properties: {
            type: { const: "scoped_text_contains" },
            selectors: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
            value: { type: "string", minLength: 1 },
          },
        },
      ],
    },
  };
}

function stateScopeSchema() {
  return {
    type: "object",
    required: ["onUnmetPrecondition"],
    additionalProperties: false,
    properties: {
      preconditions: postconditionArraySchema(),
      postconditions: postconditionArraySchema(),
      autoEnterProcessName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      onUnmetPrecondition: { enum: ["suggest_chain", "fallback"] },
    },
  };
}

export function createPromotionBatchDecisionSchema(): PromotionDecisionSchema {
  const single = createPromotionDecisionSchema().schema;
  return {
    schemaVersion: 1,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "taskId", "reasoning", "confidence", "decisions"],
      properties: {
        action: { const: "review_batch" },
        taskId: { type: "string", minLength: 1 },
        reasoning: { type: "string", minLength: 1 },
        confidence: { enum: ["low", "medium", "high"] },
        scorecardReview: {
          type: "object",
          required: ["acquisitionQuality", "reasoning"],
          additionalProperties: false,
          properties: {
            acquisitionQuality: {
              enum: ["strong", "acceptable", "thin", "poor"],
            },
            reasoning: { type: "string", minLength: 1 },
          },
        },
        obligationDispositions: {
          type: "array",
          items: {
            type: "object",
            required: ["obligationId", "action", "reasoning"],
            additionalProperties: false,
            properties: {
              obligationId: { type: "string", minLength: 1 },
              action: {
                enum: [
                  "promote",
                  "reject",
                  "delete",
                  "rerecord",
                  "acknowledge",
                ],
              },
              relatedReviewItemIds: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              reasoning: { type: "string", minLength: 1 },
            },
          },
        },
        decisions: {
          type: "array",
          minItems: 1,
          items: single,
        },
      },
    },
  };
}

function createPromotionDecisionTemplate(
  fallbackTapeId: FallbackTapeId,
  intent: string,
  suggestedPostconditions: Postcondition[],
  duplicateCandidatesPresent: boolean,
): PromotionDecision {
  const decision: PromotionDecision = {
    action: "promote",
    fallbackTapeId,
    reasoning:
      "Replace this with why the fallback is generic, repeatable, and safe to reuse.",
    confidence: "medium",
    commandName: intentToCommandName(intent),
    description: intent.trim() || "describe the reusable command",
    postconditions: suggestedPostconditions.length
      ? suggestedPostconditions
      : [{ type: "selector_exists", selector: "body" }],
  };
  if (duplicateCandidatesPresent) {
    decision.duplicateJudgment = {
      checked: true,
      duplicateOf: null,
      reasoning:
        "Replace this with why the fallback is distinct from the surfaced duplicate candidates.",
    };
  }
  return decision;
}

export function createPromotionBatchDecisionTemplate(input: {
  taskId: string;
  existingCommandNames?: string[];
  fallbacks: Array<{
    fallbackTapeId: FallbackTapeId;
    candidateSlices: CandidateOperationSlice[];
    acquisition?: {
      candidates: AcquisitionCandidate[];
    };
  }>;
}): PromotionBatchDecision {
  const decisions: PromotionDecision[] = [];
  const existingCommandNames = new Set(input.existingCommandNames || []);
  for (const fallback of input.fallbacks) {
    for (const slice of fallback.candidateSlices.filter(
      isPromotionReadySlice,
    )) {
      if (
        slice.suggestedCommandName &&
        existingCommandNames.has(slice.suggestedCommandName)
      ) {
        decisions.push({
          action: "reject",
          fallbackTapeId: fallback.fallbackTapeId,
          reviewItemId: slice.reviewItemId,
          candidateSliceId: slice.id,
          operationIndexes: slice.operationIndexes,
          reasoning: `Existing command ${slice.suggestedCommandName} already covers this suggested command name. Use the existing CLI command instead of promoting a duplicate.`,
          confidence: "high",
          agentEasyToPromote: "low",
          rejectReason: "duplicate of existing command",
        });
        continue;
      }
      decisions.push({
        action: "promote",
        fallbackTapeId: fallback.fallbackTapeId,
        reviewItemId: slice.reviewItemId,
        candidateSliceId: slice.id,
        operationIndexes: slice.operationIndexes,
        reasoning:
          "Promotion-ready candidate slice. Verify this slice is reusable independently of noisy sibling operations before applying.",
        confidence: "medium",
        agentEasyToPromote: "medium",
        commandName: slice.suggestedCommandName,
        description: slice.suggestedDescription,
        args: slice.suggestedArgs,
        valueBindings: slice.suggestedValueBindings,
        stateScope: slice.suggestedStateScope,
        postconditions: slice.suggestedPostconditions,
        outputs: slice.suggestedOutputs,
      });
      existingCommandNames.add(slice.suggestedCommandName);
    }
    for (const candidate of fallback.acquisition?.candidates || []) {
      if (!isPromotionReadyAcquisitionCandidate(candidate)) {
        if (candidate.kind === "repair" && candidate.suggestedCommandName) {
          decisions.push({
            action: "rerecord",
            fallbackTapeId: fallback.fallbackTapeId,
            reviewItemId: candidate.reviewItemId,
            operationIndexes: candidate.operationIndexes,
            reasoning:
              "Valuable candidate, but it needs reacquisition with durable selectors before promotion.",
            confidence: "medium",
            agentEasyToPromote: candidate.harnessEasyToPromote,
            rerecordReason:
              "Current evidence used weak or transient write selectors.",
            rerecordInstructions:
              "Rerun the narrow flow in the task shell, use semantic composer selectors such as role/name, label, placeholder, or aria selectors, and verify rendered final state outside the composer.",
            suggestedCommandName: candidate.suggestedCommandName,
          });
        }
        continue;
      }
      if (existingCommandNames.has(candidate.suggestedCommandName)) {
        decisions.push({
          action: "reject",
          fallbackTapeId: fallback.fallbackTapeId,
          reviewItemId: candidate.reviewItemId,
          operationIndexes: candidate.operationIndexes,
          reasoning: `Existing command ${candidate.suggestedCommandName} already covers this suggested command name. Use the existing CLI command instead of promoting a duplicate.`,
          confidence: "high",
          agentEasyToPromote: "low",
          rejectReason: "duplicate of existing command",
        });
        continue;
      }
      decisions.push({
        action: "promote",
        fallbackTapeId: fallback.fallbackTapeId,
        reviewItemId: candidate.reviewItemId,
        operationIndexes: candidate.operationIndexes,
        reasoning:
          "Promotion-ready acquisition candidate. Verify the output contract is reusable before applying.",
        confidence: "medium",
        agentEasyToPromote: candidate.harnessEasyToPromote,
        commandName: candidate.suggestedCommandName,
        description: candidate.suggestedDescription,
        args: candidate.suggestedArgs,
        valueBindings: candidate.suggestedValueBindings,
        stateScope: candidate.suggestedStateScope,
        postconditions: candidate.suggestedPostconditions,
        outputs: candidate.suggestedOutputs,
      });
      existingCommandNames.add(candidate.suggestedCommandName);
    }
    decisions.push({
      action: "reject",
      fallbackTapeId: fallback.fallbackTapeId,
      reviewItemId: `${fallback.fallbackTapeId}:fallback`,
      reasoning:
        "Reject the remaining whole fallback after independently promoting or rejecting reusable candidate slices.",
      confidence: "medium",
      agentEasyToPromote: "low",
      rejectReason:
        "Whole fallback is broader/noisier than the isolated reusable slices.",
    });
  }
  return {
    action: "review_batch",
    taskId: input.taskId,
    reasoning:
      "Review all fallback tapes for this task. Decide every promotion-ready candidate slice independently; reject only the remaining whole fallback/noisy slices.",
    confidence: "medium",
    scorecardReview: {
      acquisitionQuality: "thin",
      reasoning:
        "Replace this with the agent's honest assessment of acquisition quality after handling obligations.",
    },
    obligationDispositions: [],
    decisions,
  };
}

function isPromotionReadyAcquisitionCandidate(
  candidate: AcquisitionCandidate,
): candidate is AcquisitionCandidate & {
  suggestedCommandName: ProcessName;
  suggestedDescription: string;
  suggestedPostconditions: Postcondition[];
} {
  return Boolean(
    (candidate.kind === "read_output" ||
      candidate.kind === "write_command" ||
      candidate.kind === "navigation" ||
      candidate.kind === "state_transition") &&
      candidate.suggestedCommandName &&
      candidate.suggestedDescription &&
      candidate.suggestedPostconditions?.length &&
      candidate.harnessEasyToPromote !== "low",
  );
}

function isPromotionReadySlice(
  slice: CandidateOperationSlice,
): slice is CandidateOperationSlice & {
  suggestedCommandName: ProcessName;
  suggestedDescription: string;
  suggestedPostconditions: Postcondition[];
} {
  return Boolean(
    slice.suggestedCommandName &&
      slice.suggestedDescription &&
      slice.suggestedPostconditions?.length &&
      !slice.riskFlags?.includes("weak_write_selectors") &&
      !slice.riskFlags?.includes("rerecord_recommended"),
  );
}

function intentToCommandName(intent: string): string {
  const normalized = intent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  const withAlphaStart = /^[a-z]/.test(normalized)
    ? normalized
    : `skill_${normalized}`;
  return (
    (withAlphaStart || "new_skill").slice(0, 64).replace(/_+$/g, "") ||
    "new_skill"
  );
}

export async function writePromotionDecisionExample(
  filePath: string,
  decision: PromotionDecision,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(
    filePath,
    `${JSON.stringify(decision, null, 2)}\n`,
    "utf8",
  );
}

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Promotion decision requires ${field}.`);
  return value.trim();
}

function optionalStringField(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string when provided.`);
  return value.trim();
}

function optionalNumberArrayField(
  input: Record<string, unknown>,
  field: string,
): number[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length)
    throw new Error(`${field} must be a non-empty array when provided.`);
  return value.map((item) => {
    if (!Number.isInteger(item) || item < 0) {
      throw new Error(`${field} values must be zero-based integer indexes.`);
    }
    return item;
  });
}

function optionalProcessArgsField(
  input: Record<string, unknown>,
  field: string,
): ProcessArg[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`${field} entries must be objects.`);
    return {
      name: stringField(item, "name"),
      required: booleanField(item, "required"),
      description: stringField(item, "description"),
    };
  });
}

function optionalValueBindingsField(
  input: Record<string, unknown>,
  field: string,
): OperationValueBinding[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`${field} entries must be objects.`);
    const operationIndex = item.operationIndex;
    if (
      typeof operationIndex !== "number" ||
      !Number.isInteger(operationIndex) ||
      operationIndex < 0
    ) {
      throw new Error(`${field}.operationIndex must be a zero-based integer.`);
    }
    return {
      operationIndex,
      argName: stringField(item, "argName"),
      target: optionalBindingTarget(item, "target"),
    };
  });
}

function optionalStateScopeField(
  input: Record<string, unknown>,
  field: string,
): CommandStateScope | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const onUnmetPrecondition = stringField(value, "onUnmetPrecondition");
  if (
    onUnmetPrecondition !== "suggest_chain" &&
    onUnmetPrecondition !== "fallback"
  ) {
    throw new Error(
      `${field}.onUnmetPrecondition must be suggest_chain or fallback.`,
    );
  }
  const preconditions = optionalPostconditionsField(value, "preconditions");
  const postconditions = optionalPostconditionsField(value, "postconditions");
  const autoEnterProcessName = optionalStringField(
    value,
    "autoEnterProcessName",
  );
  return {
    ...(preconditions ? { preconditions } : {}),
    ...(postconditions ? { postconditions } : {}),
    ...(autoEnterProcessName ? { autoEnterProcessName } : {}),
    onUnmetPrecondition,
  };
}

function optionalPostconditionsField(
  input: Record<string, unknown>,
  field: string,
): Postcondition[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map(normalizePostcondition);
}

function optionalBindingTarget(
  input: Record<string, unknown>,
  field: string,
): OperationValueBinding["target"] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (value !== "argument" && value !== "selector") {
    throw new Error(`${field} must be "argument" or "selector".`);
  }
  return value;
}

function booleanField(input: Record<string, unknown>, field: string): boolean {
  const value = input[field];
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean.`);
  return value;
}

function confidenceField(
  input: Record<string, unknown>,
  field: string,
): PromotionDecisionConfidence {
  const value = stringField(input, field);
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(
    "Promotion decision confidence must be low, medium, or high.",
  );
}

function optionalEasyToPromoteField(
  input: Record<string, unknown>,
  field: string,
): "low" | "medium" | "high" | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${field} must be low, medium, or high when provided.`);
}

function optionalScorecardReviewField(
  input: Record<string, unknown>,
  field: string,
): PromotionBatchDecision["scorecardReview"] {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const acquisitionQuality = stringField(value, "acquisitionQuality");
  if (
    acquisitionQuality !== "strong" &&
    acquisitionQuality !== "acceptable" &&
    acquisitionQuality !== "thin" &&
    acquisitionQuality !== "poor"
  ) {
    throw new Error(
      `${field}.acquisitionQuality must be strong, acceptable, thin, or poor.`,
    );
  }
  return {
    acquisitionQuality,
    reasoning: stringField(value, "reasoning"),
  };
}

function optionalObligationDispositionsField(
  input: Record<string, unknown>,
  field: string,
): PromotionBatchDecision["obligationDispositions"] {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`${field} entries must be objects.`);
    const action = stringField(item, "action");
    if (
      action !== "promote" &&
      action !== "reject" &&
      action !== "delete" &&
      action !== "rerecord" &&
      action !== "acknowledge"
    ) {
      throw new Error(`${field}.action has an unsupported value.`);
    }
    const relatedReviewItemIds = item.relatedReviewItemIds;
    if (
      relatedReviewItemIds !== undefined &&
      (!Array.isArray(relatedReviewItemIds) ||
        relatedReviewItemIds.some((value) => typeof value !== "string"))
    ) {
      throw new Error(`${field}.relatedReviewItemIds must be strings.`);
    }
    return {
      obligationId: stringField(item, "obligationId"),
      action,
      relatedReviewItemIds: relatedReviewItemIds as string[] | undefined,
      reasoning: stringField(item, "reasoning"),
    };
  });
}

function postconditionsField(
  input: Record<string, unknown>,
  field: string,
): Postcondition[] {
  const value = input[field];
  if (!Array.isArray(value))
    throw new Error(`Promotion decision requires ${field}.`);
  return value.map(normalizePostcondition);
}

function optionalOutputsField(
  input: Record<string, unknown>,
  field: string,
): ProcessOutput[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error(`${field} must be an array when provided.`);
  return value.map(normalizeOutput);
}

function optionalDuplicateJudgmentField(
  input: Record<string, unknown>,
  field: string,
): DuplicateJudgment | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error(`${field} must be an object when provided.`);
  const checked = value.checked;
  if (checked !== true) throw new Error(`${field}.checked must be true.`);
  const duplicateOf = value.duplicateOf;
  if (
    duplicateOf !== null &&
    (typeof duplicateOf !== "string" || !duplicateOf.trim())
  ) {
    throw new Error(`${field}.duplicateOf must be a process name or null.`);
  }
  const normalizedDuplicateOf: string | null =
    duplicateOf === null ? null : String(duplicateOf);
  return {
    checked: true,
    duplicateOf:
      normalizedDuplicateOf === null ? null : normalizedDuplicateOf.trim(),
    reasoning: stringField(value, "reasoning"),
  };
}

function normalizePostcondition(input: unknown): Postcondition {
  if (!isRecord(input)) throw new Error("Postcondition must be an object.");
  const type = stringField(input, "type");
  if (type === "url_equals" || type === "url_contains") {
    return { type, value: stringField(input, "value") };
  }
  if (type === "selector_exists") {
    return { type, selector: stringField(input, "selector") };
  }
  if (type === "text_contains") {
    return {
      type,
      selector: stringField(input, "selector"),
      value: stringField(input, "value"),
    };
  }
  if (type === "scoped_text_contains") {
    return {
      type,
      selectors: stringArrayField(input, "selectors"),
      value: stringField(input, "value"),
    };
  }
  if (type === "rendered_text_contains") {
    return {
      type,
      selector: stringField(input, "selector"),
      value: stringField(input, "value"),
      excludeSelectors: optionalStringArrayField(input, "excludeSelectors"),
    };
  }
  throw new Error(`Unsupported postcondition type: ${type}`);
}

function stringArrayField(
  input: Record<string, unknown>,
  field: string,
): string[] {
  const value = input[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function optionalStringArrayField(
  input: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings when provided.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeOutput(input: unknown): ProcessOutput {
  if (!isRecord(input)) throw new Error("Output must be an object.");
  const source = stringField(input, "source");
  if (source !== "text")
    throw new Error(`Unsupported output source: ${source}`);
  return {
    name: stringField(input, "name"),
    source,
    selector: stringField(input, "selector"),
    description: stringField(input, "description"),
    transform: optionalOutputTransform(input, "transform"),
  };
}

function optionalOutputTransform(
  input: Record<string, unknown>,
  field: string,
): ProcessOutput["transform"] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  const type = stringField(value, "type");
  if (
    type !== "raw_text" &&
    type !== "compact_lines" &&
    type !== "notification_rows"
  ) {
    throw new Error(`Unsupported output transform: ${type}`);
  }
  const limitValue = value.limit;
  if (
    limitValue !== undefined &&
    (typeof limitValue !== "number" || limitValue < 1)
  ) {
    throw new Error(`${field}.limit must be a positive number.`);
  }
  const limit = typeof limitValue === "number" ? limitValue : undefined;
  return {
    type,
    ...(limit === undefined ? {} : { limit }),
    includePatterns: optionalStringArrayField(value, "includePatterns"),
    excludePatterns: optionalStringArrayField(value, "excludePatterns"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
