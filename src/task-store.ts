import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  FallbackTape,
  TaskFile,
  TaskFileStatus,
  TaskLifecycleGateResult,
  TaskId,
  TaskSegmentFile,
  TaskSegmentId,
  TaskSegmentStatus,
} from "./contracts.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fs-json.js";
import { sha256 } from "./hash.js";
import {
  fallbackDecisionSchemaPath,
  fallbackDecisionTemplatePath,
  fallbackReviewPath,
  fallbackReviewRequestPath,
  fallbackTapeJsonPath,
  slugifyName,
  taskJsonPath,
  taskMarkdownPath,
  taskSegmentEventJournalPath,
  taskSegmentJsonPath,
  taskSegmentMarkdownPath,
} from "./paths.js";

export interface StartFallbackSegmentInput {
  domain: Domain;
  taskId?: TaskId;
  taskIntent?: string;
  segmentIntent: string;
}

export interface StartFallbackSegmentResult {
  task: TaskFile;
  segment: TaskSegmentFile;
}

export interface CompleteTaskOptions {
  noAcquisitionReason?: string;
}

export class JsonTaskStore {
  async beginTaskId(
    domain: Domain,
    intent: string,
    now = new Date().toISOString(),
  ): Promise<TaskId> {
    return `task-${sha256({ domain, intent, createdAt: now }).slice(0, 12)}`;
  }

  async loadTask(domain: Domain, taskId: TaskId): Promise<TaskFile | null> {
    return readJsonFile<TaskFile>(taskJsonPath(domain, taskId));
  }

  async loadSegment(
    domain: Domain,
    taskId: TaskId,
    segmentId: TaskSegmentId,
  ): Promise<TaskSegmentFile | null> {
    return readJsonFile<TaskSegmentFile>(
      taskSegmentJsonPath(domain, taskId, segmentId),
    );
  }

  async beginTask(
    domain: Domain,
    intent: string,
    now = new Date().toISOString(),
  ): Promise<TaskFile> {
    const taskId = await this.beginTaskId(domain, intent, now);
    const existing = await this.loadTask(domain, taskId);
    if (existing) return existing;
    const task = this.createTask(domain, taskId, intent, now);
    await this.writeTask(domain, task);
    return task;
  }

  async startFallbackSegment(
    input: StartFallbackSegmentInput,
  ): Promise<StartFallbackSegmentResult> {
    const now = new Date().toISOString();
    const taskId =
      input.taskId ||
      (await this.beginTaskId(
        input.domain,
        input.taskIntent || input.segmentIntent,
        now,
      ));
    const existingTask = await this.loadTask(input.domain, taskId);
    const task =
      existingTask ||
      this.createTask(
        input.domain,
        taskId,
        input.taskIntent || input.segmentIntent,
        now,
      );
    if (task.status === "closed") {
      throw new Error(`Task is already closed: ${taskId}`);
    }
    task.status = "recording";
    markReviewStale(task, now);
    const segmentId = nextSegmentId(task, input.segmentIntent);
    const segment = this.createSegment(
      input.domain,
      taskId,
      segmentId,
      input.segmentIntent,
      now,
    );
    task.segments.push({
      segmentId,
      segmentPath: segment.segmentPath,
      intent: segment.intent,
      status: segment.status,
      createdAt: now,
      updatedAt: now,
    });
    task.updatedAt = now;
    await this.writeTask(input.domain, task);
    await this.writeSegment(input.domain, segment);
    return { task, segment };
  }

  async attachFallbackTape(input: {
    domain: Domain;
    taskId: TaskId;
    segmentId: TaskSegmentId;
    tape: FallbackTape;
  }): Promise<{ task: TaskFile; segment: TaskSegmentFile }> {
    const now = new Date().toISOString();
    const task = await this.requiredTask(input.domain, input.taskId);
    const segment = await this.requiredSegment(
      input.domain,
      input.taskId,
      input.segmentId,
    );
    const status: TaskSegmentStatus = "saved";
    task.status = "review_required";
    markReviewStale(task, now);
    segment.status = status;
    segment.fallbackTapeId = input.tape.id;
    segment.fallbackTapePath = fallbackTapeJsonPath(
      input.domain,
      input.tape.id,
    );
    segment.reviewPath = fallbackReviewPath(input.domain, input.tape.id);
    segment.reviewRequestPath = fallbackReviewRequestPath(
      input.domain,
      input.tape.id,
    );
    segment.decisionSchemaPath = fallbackDecisionSchemaPath(
      input.domain,
      input.tape.id,
    );
    segment.decisionTemplatePath = fallbackDecisionTemplatePath(
      input.domain,
      input.tape.id,
    );
    segment.updatedAt = now;

    const ref = task.segments.find(
      (candidate) => candidate.segmentId === input.segmentId,
    );
    if (ref) {
      ref.status = status;
      ref.fallbackTapeId = input.tape.id;
      ref.reviewPath = segment.reviewPath;
      ref.updatedAt = now;
    }
    task.updatedAt = now;

    await this.writeTask(input.domain, task);
    await this.writeSegment(input.domain, segment);
    return { task, segment };
  }

  async markSegmentStatus(input: {
    domain: Domain;
    taskId: TaskId;
    segmentId: TaskSegmentId;
    status: TaskSegmentStatus;
    reason?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const task = await this.requiredTask(input.domain, input.taskId);
    const segment = await this.requiredSegment(
      input.domain,
      input.taskId,
      input.segmentId,
    );
    segment.status = input.status;
    if (input.status === "abandoned" && input.reason) {
      segment.abandonedReason = input.reason;
    }
    segment.updatedAt = now;
    if (
      input.status === "promoted" ||
      input.status === "rejected" ||
      input.status === "deleted" ||
      input.status === "rerecord_requested" ||
      input.status === "abandoned"
    ) {
      segment.closedAt = now;
    }
    const ref = task.segments.find(
      (candidate) => candidate.segmentId === input.segmentId,
    );
    if (ref) {
      ref.status = input.status;
      if (input.status === "abandoned" && input.reason) {
        ref.abandonedReason = input.reason;
      }
      ref.updatedAt = now;
    }
    task.status = deriveTaskStatus(task, input.status);
    task.updatedAt = now;
    await this.writeTask(input.domain, task);
    await this.writeSegment(input.domain, segment);
  }

  async markReviewCreated(input: {
    domain: Domain;
    taskId: TaskId;
    reviewPath: string;
    reviewRequestPath: string;
    decisionSchemaPath: string;
    decisionTemplatePath: string;
    coversFallbackTapeIds: string[];
  }): Promise<TaskFile> {
    const now = new Date().toISOString();
    const task = await this.requiredTask(input.domain, input.taskId);
    task.status = "decision_required";
    task.review = {
      reviewId: sha256({
        taskId: input.taskId,
        coversFallbackTapeIds: input.coversFallbackTapeIds,
        createdAt: now,
      }),
      status: "created",
      reviewPath: input.reviewPath,
      reviewRequestPath: input.reviewRequestPath,
      decisionSchemaPath: input.decisionSchemaPath,
      decisionTemplatePath: input.decisionTemplatePath,
      coversFallbackTapeIds: input.coversFallbackTapeIds,
      createdAt: now,
    };
    task.updatedAt = now;
    await this.writeTask(input.domain, task);
    return task;
  }

  async markReviewApplied(input: {
    domain: Domain;
    taskId: TaskId;
  }): Promise<TaskFile> {
    const now = new Date().toISOString();
    const task = await this.requiredTask(input.domain, input.taskId);
    task.status = "decision_applied";
    if (task.review) {
      task.review.status = "applied";
      task.review.appliedAt = now;
    }
    task.updatedAt = now;
    await this.writeTask(input.domain, task);
    return task;
  }

  async completeTask(
    domain: Domain,
    taskId: TaskId,
    options: CompleteTaskOptions = {},
  ): Promise<TaskFile> {
    const now = new Date().toISOString();
    const task = await this.requiredTask(domain, taskId);
    const gate = await this.canCompleteTask(domain, taskId, options);
    if (!gate.allowed) {
      throw new TaskLifecycleGateError(gate);
    }
    const noAcquisitionReason = normalizeReason(options.noAcquisitionReason);
    task.status = "closed";
    task.completionKind = noAcquisitionReason ? "no_acquisition" : "normal";
    if (noAcquisitionReason) {
      task.completionReason = noAcquisitionReason;
    }
    task.closedAt = now;
    task.updatedAt = now;
    await this.writeTask(domain, task);
    return task;
  }

  async canReviewTask(
    domain: Domain,
    taskId: TaskId,
  ): Promise<TaskLifecycleGateResult> {
    const task = await this.requiredTask(domain, taskId);
    const segments = await this.segmentsForTask(domain, taskId);
    if (task.status === "closed") {
      return {
        allowed: false,
        requiredAction: "task_already_closed",
        reason: "Task is already closed.",
      };
    }
    const recording = segments.filter(
      (segment) => segment.status === "recording",
    );
    if (recording.length) {
      return {
        allowed: false,
        requiredAction: "save_or_abandon_recording_segments",
        reason: "Task has fallback segments still recording.",
        command: `node packages/cartographer/dist/cli.js abandon-segment ${domain} --task-id ${taskId} --segment-id <segment-id> --reason <reason>`,
      };
    }
    const saved = segments.filter((segment) => segment.status === "saved");
    if (!saved.length) {
      return {
        allowed: false,
        requiredAction: "complete_task",
        reason: "Task has no saved fallback tapes requiring review.",
        command: `node packages/cartographer/dist/cli.js complete-task ${domain} --task-id ${taskId}`,
      };
    }
    return { allowed: true };
  }

  async canApplyTaskDecision(
    domain: Domain,
    taskId: TaskId,
    fallbackTapeIds: string[],
  ): Promise<TaskLifecycleGateResult> {
    const task = await this.requiredTask(domain, taskId);
    const segments = await this.segmentsForTask(domain, taskId);
    if (
      task.status !== "decision_required" ||
      task.review?.status !== "created"
    ) {
      return {
        allowed: false,
        requiredAction: "review_task",
        reason:
          "Task must have a fresh review before decisions can be applied.",
        command: `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${taskId}`,
      };
    }
    const expected = segments
      .filter((segment) => segment.status === "saved" && segment.fallbackTapeId)
      .map((segment) => String(segment.fallbackTapeId))
      .sort();
    const actual = [...new Set(fallbackTapeIds)].sort();
    if (
      expected.length !== actual.length ||
      expected.some((id, index) => id !== actual[index])
    ) {
      return {
        allowed: false,
        requiredAction: "fix_decision_file",
        reason: `Batch decision must cover every saved fallback exactly once. expected=${expected.join(",") || "none"} actual=${actual.join(",") || "none"}`,
      };
    }
    const covered = [...(task.review.coversFallbackTapeIds || [])].sort();
    if (
      expected.length !== covered.length ||
      expected.some((id, index) => id !== covered[index])
    ) {
      return {
        allowed: false,
        requiredAction: "review_task",
        reason: "Saved fallback set changed after the review was created.",
        command: `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${taskId}`,
      };
    }
    return { allowed: true };
  }

  async canCompleteTask(
    domain: Domain,
    taskId: TaskId,
    options: CompleteTaskOptions = {},
  ): Promise<TaskLifecycleGateResult> {
    const task = await this.requiredTask(domain, taskId);
    if (task.status === "closed") {
      return {
        allowed: false,
        requiredAction: "task_already_closed",
        reason: "Task is already closed.",
      };
    }
    const segments = await this.segmentsForTask(domain, taskId);
    const recording = segments.filter(
      (segment) => segment.status === "recording",
    );
    if (recording.length) {
      return {
        allowed: false,
        requiredAction: "save_or_abandon_recording_segments",
        reason: "Task has fallback segments still recording.",
      };
    }
    const undecided = segments.filter((segment) => segment.status === "saved");
    if (undecided.length) {
      return {
        allowed: false,
        requiredAction:
          task.status === "decision_required"
            ? "apply_promotion_decision"
            : "review_task",
        reason: "Task has saved fallback tapes without applied decisions.",
        command:
          task.status === "decision_required"
            ? `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`
            : `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${taskId}`,
      };
    }
    if (
      segments.some((segment) => segment.fallbackTapeId) &&
      task.status !== "decision_applied"
    ) {
      return {
        allowed: false,
        requiredAction: "apply_promotion_decision",
        reason:
          "Fallback-backed task must have applied decisions before completion.",
        command: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
      };
    }
    if (
      segments.length > 0 &&
      !segments.some((segment) => segment.fallbackTapeId) &&
      !normalizeReason(options.noAcquisitionReason)
    ) {
      return {
        allowed: false,
        requiredAction: "explain_no_acquisition",
        reason:
          "Task has fallback segments but no saved acquisition packet or applied decision. Complete only with an explicit no-acquisition reason.",
        command: `node packages/cartographer/dist/cli.js complete-task ${domain} --task-id ${taskId} --no-acquisition-reason <reason>`,
      };
    }
    return { allowed: true };
  }

  async segmentsForTask(
    domain: Domain,
    taskId: TaskId,
  ): Promise<TaskSegmentFile[]> {
    const task = await this.requiredTask(domain, taskId);
    const segments = [];
    for (const ref of task.segments) {
      const segment = await this.loadSegment(domain, taskId, ref.segmentId);
      if (segment) segments.push(segment);
    }
    return segments;
  }

  private createTask(
    domain: Domain,
    taskId: TaskId,
    intent: string,
    now: string,
  ): TaskFile {
    return {
      schemaVersion: 1,
      taskId,
      domain,
      intent,
      status: "open",
      taskPath: taskJsonPath(domain, taskId),
      taskMarkdownPath: taskMarkdownPath(domain, taskId),
      segments: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private createSegment(
    domain: Domain,
    taskId: TaskId,
    segmentId: TaskSegmentId,
    intent: string,
    now: string,
  ): TaskSegmentFile {
    return {
      schemaVersion: 1,
      taskId,
      segmentId,
      domain,
      intent,
      status: "recording",
      surface: "fallback",
      segmentPath: taskSegmentJsonPath(domain, taskId, segmentId),
      segmentMarkdownPath: taskSegmentMarkdownPath(domain, taskId, segmentId),
      eventJournalPath: taskSegmentEventJournalPath(domain, taskId, segmentId),
      createdAt: now,
      updatedAt: now,
    };
  }

  private async requiredTask(
    domain: Domain,
    taskId: TaskId,
  ): Promise<TaskFile> {
    const task = await this.loadTask(domain, taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private async requiredSegment(
    domain: Domain,
    taskId: TaskId,
    segmentId: TaskSegmentId,
  ): Promise<TaskSegmentFile> {
    const segment = await this.loadSegment(domain, taskId, segmentId);
    if (!segment)
      throw new Error(`Unknown task segment: ${taskId}/${segmentId}`);
    return segment;
  }

  private async writeTask(domain: Domain, task: TaskFile): Promise<void> {
    await writeJsonFile(taskJsonPath(domain, task.taskId), task);
    await writeMarkdown(
      taskMarkdownPath(domain, task.taskId),
      renderTaskMarkdown(task),
    );
  }

  private async writeSegment(
    domain: Domain,
    segment: TaskSegmentFile,
  ): Promise<void> {
    await writeJsonFile(
      taskSegmentJsonPath(domain, segment.taskId, segment.segmentId),
      segment,
    );
    await writeMarkdown(
      taskSegmentMarkdownPath(domain, segment.taskId, segment.segmentId),
      renderSegmentMarkdown(segment),
    );
  }
}

function nextSegmentId(task: TaskFile, intent: string): TaskSegmentId {
  const index = String(task.segments.length + 1).padStart(3, "0");
  const slug = slugifyName(intent).slice(0, 48) || "fallback-segment";
  return `${index}-${slug}`;
}

function renderTaskMarkdown(task: TaskFile): string {
  const lines = [
    `# Cartographer Task ${task.taskId}`,
    "",
    `- Domain: ${task.domain}`,
    `- Intent: ${task.intent}`,
    `- Status: ${task.status}`,
    `- Created: ${task.createdAt}`,
    `- Updated: ${task.updatedAt}`,
    "",
    "## Segments",
    "",
  ];
  if (task.review) {
    lines.push(`- Review status: ${task.review.status}`);
    lines.push(`- Review request: ${task.review.reviewRequestPath}`);
  }
  if (task.completionKind) {
    lines.push(`- Completion kind: ${task.completionKind}`);
  }
  if (task.completionReason) {
    lines.push(`- Completion reason: ${task.completionReason}`);
  }
  if (!task.segments.length) {
    lines.push("No fallback-backed segments recorded.");
  }
  for (const segment of task.segments) {
    lines.push(`- ${segment.segmentId}: ${segment.intent}`);
    lines.push(`  - Status: ${segment.status}`);
    lines.push(`  - Segment JSON: ${segment.segmentPath}`);
    if (segment.fallbackTapeId)
      lines.push(`  - Fallback tape: ${segment.fallbackTapeId}`);
    if (segment.reviewPath) lines.push(`  - Review: ${segment.reviewPath}`);
  }
  lines.push("", "## Review", "");
  lines.push(
    `Run: node packages/cartographer/dist/cli.js review-task ${task.domain} --task-id ${task.taskId}`,
  );
  return `${lines.join("\n")}\n`;
}

function normalizeReason(value?: string): string {
  return String(value || "").trim();
}

function renderSegmentMarkdown(segment: TaskSegmentFile): string {
  const lines = [
    `# Cartographer Segment ${segment.segmentId}`,
    "",
    `- Task: ${segment.taskId}`,
    `- Domain: ${segment.domain}`,
    `- Intent: ${segment.intent}`,
    `- Surface: ${segment.surface}`,
    `- Status: ${segment.status}`,
    `- Created: ${segment.createdAt}`,
    `- Updated: ${segment.updatedAt}`,
    "",
    "## Links",
    "",
  ];
  if (segment.fallbackTapeId)
    lines.push(`- Fallback tape: ${segment.fallbackTapeId}`);
  if (segment.fallbackTapePath)
    lines.push(`- Fallback JSON: ${segment.fallbackTapePath}`);
  if (segment.reviewPath) lines.push(`- Review: ${segment.reviewPath}`);
  if (segment.reviewRequestPath)
    lines.push(`- Review request: ${segment.reviewRequestPath}`);
  if (segment.decisionSchemaPath)
    lines.push(`- Decision schema: ${segment.decisionSchemaPath}`);
  if (segment.decisionTemplatePath)
    lines.push(`- Decision template: ${segment.decisionTemplatePath}`);
  if (!segment.fallbackTapeId)
    lines.push("- Fallback tape: pending save-fallback");
  return `${lines.join("\n")}\n`;
}

async function writeMarkdown(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

export class TaskLifecycleGateError extends Error {
  constructor(readonly gate: TaskLifecycleGateResult) {
    super(gate.reason || "Task lifecycle gate failed.");
  }
}

function deriveTaskStatus(
  task: TaskFile,
  lastSegmentStatus: TaskSegmentStatus,
): TaskFileStatus {
  if (lastSegmentStatus === "recording") return "recording";
  if (task.segments.some((segment) => segment.status === "recording")) {
    return "recording";
  }
  if (task.segments.some((segment) => segment.status === "saved")) {
    return task.review?.status === "created"
      ? "decision_required"
      : "review_required";
  }
  if (task.segments.some((segment) => segment.fallbackTapeId)) {
    return "decision_applied";
  }
  return "open";
}

function markReviewStale(task: TaskFile, now: string): void {
  if (!task.review || task.review.status !== "created") return;
  task.review.status = "stale";
  task.review.staleAt = now;
}
