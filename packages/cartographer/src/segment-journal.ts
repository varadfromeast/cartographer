import fs from "node:fs/promises";
import type {
  Domain,
  FallbackOperation,
  ProcessName,
  RunProcessResult,
  TaskId,
  TaskSegmentId,
} from "./contracts.js";
import { appendJsonLine } from "./fs-json.js";
import { sha256 } from "./hash.js";
import { taskSegmentEventJournalPath } from "./paths.js";
import { JsonTaskStore } from "./task-store.js";

export async function appendSegmentOperation(input: {
  domain: Domain;
  taskId: TaskId;
  segmentId: TaskSegmentId;
  operation: FallbackOperation;
}): Promise<void> {
  await appendJsonLine(
    taskSegmentEventJournalPath(input.domain, input.taskId, input.segmentId),
    input.operation,
  );
}

export async function appendCliOperationToActiveSegment(input: {
  domain: Domain;
  taskId?: TaskId;
  command: string;
  processName: ProcessName;
  writesToPlatform: boolean;
  result: RunProcessResult;
}): Promise<FallbackOperation | null> {
  if (!input.taskId) return null;
  const taskStore = new JsonTaskStore();
  const task = await taskStore.loadTask(input.domain, input.taskId);
  if (!task || task.status !== "recording") return null;
  const segments = await taskStore.segmentsForTask(input.domain, input.taskId);
  const activeSegment = [...segments]
    .reverse()
    .find((segment) => segment.status === "recording");
  if (!activeSegment) return null;

  const createdAt = new Date().toISOString();
  const operation: FallbackOperation = {
    id: sha256({
      taskId: input.taskId,
      segmentId: activeSegment.segmentId,
      surface: "cli",
      command: input.command,
      processName: input.processName,
      createdAt,
    }),
    kind: "cli",
    surface: "cli",
    promotionEligible: false,
    instruction: input.command,
    command: input.command,
    processName: input.processName,
    success: input.result.success,
    failureReason: input.result.success
      ? undefined
      : input.result.failure?.reason || input.result.message,
    visualReview: input.result.visualReview,
    writesToPlatform: input.writesToPlatform,
    createdAt,
  };
  await appendSegmentOperation({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: activeSegment.segmentId,
    operation,
  });
  return operation;
}

export async function readSegmentOperations(
  eventJournalPath?: string,
): Promise<FallbackOperation[]> {
  if (!eventJournalPath) return [];
  let raw = "";
  try {
    raw = await fs.readFile(eventJournalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FallbackOperation);
}
