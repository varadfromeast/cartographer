#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { StagehandBrowserSessionFactory } from "./browser-session.js";
import { NodeCliEmitter } from "./cli-emitter.js";
import type {
  Domain,
  CartographerRuntime,
  ProcessArg,
  RunProcessResult,
  TapeCatalog,
  TaskLifecycleGateResult,
} from "./contracts.js";
import { createPreloadedRuntime, parseRuntimeArgs } from "./factory.js";
import { BasicStateIdentity } from "./state-identity.js";
import { JsonStateActionCache } from "./state-action-cache.js";
import { JsonTapeStore } from "./tape-store.js";
import { ProcessTapeRecorder } from "./manual-recorder.js";
import {
  binDir,
  cartographerHome,
  catalogPath,
  manifestPath,
  recordingDirs,
  siteDir,
  skillPath,
  slugifyName,
  tapeDir,
} from "./paths.js";
import { recordScriptedInstagramDm } from "./instagram-scripted.js";
import { JsonFallbackTapeStore, JsonPromotionStore } from "./fallback-store.js";
import { JsonTaskStore } from "./task-store.js";
import { emitSkillManifest, emitSkillMd } from "./skill-emitter.js";
import { sha256 } from "./hash.js";
import type { EvidenceArtifact, TapeStep } from "./contracts.js";
import { DefaultFallbackReviewer } from "./fallback-reviewer.js";
import { DefaultSkillPromoter } from "./skill-promoter.js";
import { DefaultEndOfTaskReviewer } from "./end-of-task-reviewer.js";
import { ConsoleCartographerLogger } from "./logger.js";
import {
  createPromotionReviewArtifacts,
  DefaultPromotionDecisionApplier,
  readPromotionDecisionFile,
} from "./promotion-decision.js";
import { createTaskPromotionReviewArtifacts } from "./task-review.js";
import { classifySelector as classifyCartographerSelector } from "./playwright-selector.js";
import { closeTaskBrowser } from "./task-browser.js";
import { appendCliOperationToActiveSegment } from "./segment-journal.js";
import { SimpleStateScopedSkillPlanner } from "./state-skill-planner.js";
import {
  isPlaywrightCliCommand,
  RecordedPlaywrightCliSession,
  runRecordedPlaywrightCli,
} from "./playwright-cli-adapter.js";
import { materializeRecordingSegments } from "./pw-segment-materializer.js";

async function main(): Promise<void> {
  const cliArgs = process.argv
    .slice(2)
    .filter((arg, index) => !(index === 0 && arg === "--"));
  const [command, ...args] = cliArgs;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === "teach" && args[0] === "instagram") {
    await teachInstagram();
    return;
  }

  if (command === "begin-task") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const intent = String(parsed.args.intent || "");
    if (!intent) {
      throw new Error(
        "Usage: cartographer begin-task instagram.com --intent <task>",
      );
    }
    const task = await new JsonTaskStore().beginTask(domain, intent);
    console.log(
      JSON.stringify(
        {
          domain,
          intent,
          taskId: task.taskId,
          taskStartedAt: task.createdAt,
          taskPath: task.taskPath,
          taskMarkdownPath: task.taskMarkdownPath,
          contractPaths: [
            `packages/cartographer/skills/${domain}/SKILL.md`,
            `packages/cartographer/skills/${domain}/manifest.json`,
          ],
          fallbackCommand: `node packages/cartographer/dist/cli.js pw ${domain} --task-id ${task.taskId} --intent "<segment intent>" snapshot`,
          taskScopedCommandFlag: `--task-id ${task.taskId}`,
          requiredReviewCommand: `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${task.taskId}`,
          acquisitionPolicy:
            "If fallback recording is used, the task is not complete until review-task creates a batch review, apply-promotion-decision applies it, and complete-task closes the task.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "fallback") {
    const domain = parseDomain(args[0]);
    printDeprecatedMutationCommand({
      command: "fallback",
      reason:
        "Interactive fallback prompt is deprecated. It bypasses the Playwright-CLI-style command surface used by current evidence and slicing.",
      requiredAction: "use_pw_fallback",
      replacement: `node packages/cartographer/dist/cli.js pw ${domain} --task-id <task-id> --intent <segment> snapshot`,
      applyCommand: `node packages/cartographer/dist/cli.js review-task ${domain} --task-id <task-id>`,
    });
    return;
  }

  if (command === "show-task") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = String(parsed.args.taskId || "");
    if (!taskId) {
      throw new Error(
        "Usage: cartographer show-task instagram.com --task-id <task-id>",
      );
    }
    const taskStore = new JsonTaskStore();
    const task = await taskStore.loadTask(domain, taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const segments = await taskStore.segmentsForTask(domain, taskId);
    const reviewGate = await taskStore.canReviewTask(domain, taskId);
    const completeGate = await taskStore.canCompleteTask(domain, taskId);
    const nextCommand =
      task.status === "closed"
        ? undefined
        : reviewGate.allowed
          ? `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${taskId}`
          : completeGate.allowed
            ? `node packages/cartographer/dist/cli.js complete-task ${domain} --task-id ${taskId}`
            : completeGate.command || reviewGate.command;
    console.log(
      JSON.stringify(
        {
          success: true,
          task: {
            taskId: task.taskId,
            domain: task.domain,
            intent: task.intent,
            status: task.status,
            taskPath: task.taskPath,
            taskMarkdownPath: task.taskMarkdownPath,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            closedAt: task.closedAt,
          },
          review: task.review,
          segments: segments.map((segment) => ({
            segmentId: segment.segmentId,
            intent: segment.intent,
            status: segment.status,
            fallbackTapeId: segment.fallbackTapeId,
            segmentPath: segment.segmentPath,
            segmentMarkdownPath: segment.segmentMarkdownPath,
            eventJournalPath: segment.eventJournalPath,
            fallbackTapePath: segment.fallbackTapePath,
            reviewPath: segment.reviewPath,
            reviewRequestPath: segment.reviewRequestPath,
            decisionSchemaPath: segment.decisionSchemaPath,
            decisionTemplatePath: segment.decisionTemplatePath,
            abandonedReason: segment.abandonedReason,
            createdAt: segment.createdAt,
            updatedAt: segment.updatedAt,
            closedAt: segment.closedAt,
          })),
          lifecycle: {
            canReview: reviewGate,
            canComplete: completeGate,
            nextCommand,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "task-summary") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = String(parsed.args.taskId || "");
    if (!taskId) {
      throw new Error(
        "Usage: cartographer task-summary instagram.com --task-id <task-id>",
      );
    }
    const taskStore = new JsonTaskStore();
    const fallbackStore = new JsonFallbackTapeStore();
    const task = await taskStore.loadTask(domain, taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const segments = await taskStore.segmentsForTask(domain, taskId);
    const segmentSummaries = [];
    const performedActions: string[] = [];
    let finalVerification: string | undefined;
    for (const segment of segments) {
      const tape = segment.fallbackTapeId
        ? await fallbackStore.load(domain, segment.fallbackTapeId)
        : null;
      const operations = tape?.operations || [];
      for (const operation of operations) {
        if (!operation.success) continue;
        performedActions.push(
          `${segment.intent}: ${operation.kind} ${operation.selector || operation.command || ""}`.trim(),
        );
        if (operation.evidenceSummary?.preview.length) {
          finalVerification =
            operation.evidenceSummary.preview[0] ||
            operation.evidenceSummary.preview.join("; ");
        }
      }
      segmentSummaries.push({
        segmentId: segment.segmentId,
        intent: segment.intent,
        status: segment.status,
        fallbackTapeId: segment.fallbackTapeId,
        operationCount: operations.length,
        writeCount: operations.filter((operation) => operation.writesToPlatform)
          .length,
      });
    }
    console.log(
      JSON.stringify(
        {
          success: true,
          taskId: task.taskId,
          intent: task.intent,
          status: task.status,
          closed: task.status === "closed",
          reviewStatus: task.review?.status,
          reviewedFallbacks: task.review?.coversFallbackTapeIds || [],
          segmentSummaries,
          performedActions: performedActions.slice(-20),
          finalVerification,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "shell" || command === "use") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    let taskId = parsed.args.taskId ? String(parsed.args.taskId) : "";
    const taskIntent = String(
      parsed.args.task || parsed.args.taskIntent || "",
    ).trim();
    const initialIntent = String(parsed.args.intent || "fallback").trim();
    const taskStore = new JsonTaskStore();
    if (!taskId) {
      if (!taskIntent) {
        throw new Error(
          `Usage: cartographer ${command} instagram.com --task-id <task-id> [--intent <segment>] OR cartographer ${command} instagram.com --task "<task intent>"`,
        );
      }
      const task = await taskStore.beginTask(domain, taskIntent);
      taskId = task.taskId;
    } else {
      const task = await taskStore.loadTask(domain, taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.status === "closed") {
        throw new Error(`Task is already closed: ${taskId}`);
      }
    }
    await runCartographerShell({
      domain,
      taskId,
      intent: initialIntent || "fallback",
    });
    process.exit(0);
    return;
  }

  if (command === "pw") {
    const domain = parseDomain(args[0]);
    const parsed = parsePwArgs(args.slice(1));
    if (!parsed.taskId) {
      printGateFailure(
        {
          allowed: false,
          requiredAction: "begin_task",
          reason: "`cartographer pw` requires --task-id.",
          command: `node packages/cartographer/dist/cli.js begin-task ${domain} --intent <task-intent>`,
        },
        {},
      );
      return;
    }
    if (!parsed.command) {
      throw new Error(
        "Usage: cartographer pw instagram.com --task-id <task-id> [--intent <segment>] <playwright-cli-command> [args...]",
      );
    }
    const activeSegment = await ensureRecordingSegment({
      domain,
      taskId: parsed.taskId,
      intent: parsed.intent?.trim() || "playwright cli fallback",
    });
    const result = await runRecordedPlaywrightCli({
      domain,
      taskId: parsed.taskId,
      segmentId: activeSegment.segmentId,
      intent: activeSegment.intent,
      command: parsed.command,
      args: parsed.commandArgs,
      json: parsed.json,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.stderr.trim()) console.error(result.stderr.trim());
      console.log(
        `cartographer recorded ${result.command} success=${String(result.success)} segment=${activeSegment.segmentId}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }

  if (command === "abandon-segment") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = parsed.args.taskId ? String(parsed.args.taskId) : "";
    const segmentId = parsed.args.segmentId
      ? String(parsed.args.segmentId)
      : "";
    const reason = parsed.args.reason ? String(parsed.args.reason) : "";
    if (!taskId || !segmentId || !reason) {
      throw new Error(
        "Usage: cartographer abandon-segment instagram.com --task-id <task-id> --segment-id <segment-id> --reason <reason>",
      );
    }
    const taskStore = new JsonTaskStore();
    await taskStore.markSegmentStatus({
      domain,
      taskId,
      segmentId,
      status: "abandoned",
      reason,
    });
    console.log(
      JSON.stringify(
        {
          success: true,
          taskId,
          segmentId,
          status: "abandoned",
          reason,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "teach-stagehand" && args[0] === "instagram") {
    await teachInstagram();
    return;
  }

  if (command === "emit-cli") {
    const domain = parseDomain(args[0]);
    const result = await emitCli(domain);
    const shortcutPath = await emitCartographerShortcut();
    console.log(JSON.stringify(result, null, 2));
    if (shortcutPath) {
      console.error(`emitted ${shortcutPath}`);
    }
    return;
  }

  if (command === "emit-skill") {
    const domain = parseDomain(args[0]);
    const outputPath = await emitSkillMd(domain);
    const manifestOutputPath = await emitSkillManifest(domain);
    console.log(JSON.stringify({ outputPath, manifestOutputPath }, null, 2));
    return;
  }

  if (command === "emit-manifest") {
    const domain = parseDomain(args[0]);
    const outputPath = await emitSkillManifest(domain);
    console.log(JSON.stringify({ outputPath }, null, 2));
    return;
  }

  if (command === "expose-skills") {
    const domain = parseDomain(args[0]);
    const homeOnly = args.includes("--home-only");
    const outputPath = homeOnly
      ? await emitSkillMd(domain)
      : await emitSkillMd(
          domain,
          path.resolve(
            process.cwd(),
            "packages",
            "cartographer",
            "skills",
            domain,
            "SKILL.md",
          ),
        );
    const manifestOutputPath = homeOnly
      ? await emitSkillManifest(domain)
      : await emitSkillManifest(
          domain,
          path.resolve(
            process.cwd(),
            "packages",
            "cartographer",
            "skills",
            domain,
            "manifest.json",
          ),
        );
    const shortcutPath = await emitCartographerShortcut();
    console.log(JSON.stringify({ outputPath, manifestOutputPath }, null, 2));
    if (shortcutPath) {
      console.error(`emitted ${shortcutPath}`);
    }
    return;
  }

  if (command === "plan") {
    const domain = parseDomain(args[0]);
    const commandOrProcessName = args[1];
    if (!commandOrProcessName) {
      throw new Error("Usage: cartographer plan instagram.com <process-name>");
    }
    const tapeStore = new JsonTapeStore();
    const resolved = await resolveProcessForCommand({
      domain,
      commandOrProcessName,
      tapeStore,
    });
    const catalog = await tapeStore.loadCatalog(domain);
    if (!catalog) throw new Error(`No tape catalog found for ${domain}`);
    const plan = new SimpleStateScopedSkillPlanner().plan({
      domain,
      targetProcessName: resolved.processName,
      catalog,
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === "capture-fallback") {
    const domain = parseDomain(args[0]);
    const processName = args[1];
    if (!processName) {
      throw new Error(
        "Usage: cartographer capture-fallback instagram.com <process> --intent <intent>",
      );
    }
    const parsed = parseRuntimeArgs(args.slice(2));
    const intent = String(parsed.args.intent || "");
    if (!intent) {
      throw new Error(
        "Usage: cartographer capture-fallback instagram.com <process> --intent <intent>",
      );
    }
    const processTape = await new JsonTapeStore().loadProcess(
      domain,
      processName,
    );
    if (!processTape) throw new Error(`Unknown process: ${processName}`);
    const now = new Date().toISOString();
    const tape = {
      id: sha256({ domain, processName, intent, createdAt: now }),
      domain,
      intent,
      source: "imported_process" as const,
      status: "succeeded" as const,
      entry: processTape.entry,
      steps: processTape.steps,
      operations: processTape.steps.map((step, index) => ({
        id: sha256({
          domain,
          processName,
          stepId: step.id,
          operationIndex: index,
          createdAt: now,
        }),
        kind: "record_step" as const,
        instruction: `import process step ${step.name}`,
        urlBefore: step.before.url,
        urlAfter: step.after.url,
        selector: step.actions[0]?.selector,
        selectorKind: classifySelector(step.actions[0]?.selector || ""),
        stepId: step.id,
        writesToPlatform: step.writesToPlatform,
        createdAt: now,
      })),
      evidence: [] as EvidenceArtifact[],
      args: processTape.args,
      writesToPlatform: processTape.writesToPlatform,
      recordingStartedAt: now,
      createdAt: now,
      completedAt: now,
    };
    await new JsonFallbackTapeStore().save(tape);
    console.log(
      JSON.stringify(
        { fallbackTapeId: tape.id, stepCount: tape.steps.length },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "review-fallbacks") {
    const domain = parseDomain(args[0]);
    const result = await createFallbackReviewer().review(domain);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "complete-task") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = String(parsed.args.taskId || "");
    const noAcquisitionReason = String(
      parsed.args.noAcquisitionReason || "",
    ).trim();
    if (!taskId) {
      throw new Error(
        "Usage: cartographer complete-task instagram.com --task-id <task-id> [--no-acquisition-reason <reason>]",
      );
    }
    const taskStore = new JsonTaskStore();
    const gate = await taskStore.canCompleteTask(domain, taskId, {
      noAcquisitionReason,
    });
    if (!gate.allowed) {
      printGateFailure(gate, { taskId });
      return;
    }
    const task = await taskStore.completeTask(domain, taskId, {
      noAcquisitionReason,
    });
    const browser = await closeTaskBrowser(domain, taskId);
    console.log(
      JSON.stringify(
        {
          success: true,
          taskId,
          status: task.status,
          taskPath: task.taskPath,
          taskMarkdownPath: task.taskMarkdownPath,
          completionKind: task.completionKind,
          completionReason: task.completionReason,
          browser,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "end-task-review") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = parsed.args.taskId ? String(parsed.args.taskId) : undefined;
    const decisionAction = String(parsed.args.decision || "");
    const noAcquisitionReason = String(
      parsed.args.noAcquisitionReason || "",
    ).trim();
    if (taskId && !decisionAction && !parsed.args.since) {
      const taskStore = new JsonTaskStore();
      const gate = await taskStore.canCompleteTask(domain, taskId, {
        noAcquisitionReason,
      });
      if (!gate.allowed) {
        printGateFailure(gate, { taskId });
        return;
      }
      const task = await taskStore.completeTask(domain, taskId, {
        noAcquisitionReason,
      });
      const browser = await closeTaskBrowser(domain, taskId);
      console.log(
        JSON.stringify(
          {
            success: true,
            alias: "end-task-review",
            preferredCommand: `node packages/cartographer/dist/cli.js complete-task ${domain} --task-id ${taskId}`,
            taskId,
            status: task.status,
            taskPath: task.taskPath,
            taskMarkdownPath: task.taskMarkdownPath,
            completionKind: task.completionKind,
            completionReason: task.completionReason,
            browser,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (decisionAction) {
      printDeprecatedMutationCommand({
        command: "end-task-review --decision",
        reason:
          "Inline end-task-review decisions bypass the typed PromotionDecision schema and cannot carry stateScope.",
        replacement: taskId
          ? `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${taskId}`
          : `node packages/cartographer/dist/cli.js create-promotion-review ${domain} <fallback-id>`,
        applyCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
      });
      return;
    }
    let scopedTask: Awaited<ReturnType<JsonTaskStore["loadTask"]>> | undefined;
    let scopedSegments:
      | Awaited<ReturnType<JsonTaskStore["segmentsForTask"]>>
      | undefined;
    if (taskId) {
      const taskStore = new JsonTaskStore();
      scopedTask = await taskStore.loadTask(domain, taskId);
      if (!scopedTask) throw new Error(`Unknown task: ${taskId}`);
      scopedSegments = await taskStore.segmentsForTask(domain, taskId);
      const openSegments = scopedSegments.filter(
        (segment) => segment.status === "recording",
      );
      if (openSegments.length) {
        process.exitCode = 1;
        console.log(
          JSON.stringify(
            {
              success: false,
              requiredAction: "save_or_abandon_recording_segments",
              task: {
                taskId,
                taskPath: scopedTask.taskPath,
                taskMarkdownPath: scopedTask.taskMarkdownPath,
                segmentCount: scopedSegments.length,
              },
              openSegments: openSegments.map((segment) => ({
                segmentId: segment.segmentId,
                intent: segment.intent,
                status: segment.status,
                segmentPath: segment.segmentPath,
                abandonCommand: `node packages/cartographer/dist/cli.js abandon-segment ${domain} --task-id ${taskId} --segment-id ${segment.segmentId} --reason <reason>`,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
    }
    const result = await createEndOfTaskReviewer().reviewCompletedTask({
      domain,
      taskStartedAt: taskId
        ? undefined
        : parsed.args.since
          ? String(parsed.args.since)
          : undefined,
    });
    if (taskId) {
      const taskStore = new JsonTaskStore();
      const task = scopedTask;
      const segments = scopedSegments || [];
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      const fallbackIds = new Set(
        segments.flatMap((segment) =>
          segment.fallbackTapeId ? [segment.fallbackTapeId] : [],
        ),
      );
      result.review.unpromotedFallbacks =
        result.review.unpromotedFallbacks.filter((packet) =>
          fallbackIds.has(packet.id),
        );
      console.log(
        JSON.stringify(
          {
            task: {
              taskId,
              taskPath: task.taskPath,
              taskMarkdownPath: task.taskMarkdownPath,
              segmentCount: segments.length,
            },
            ...result,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "inspect-fallback") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error(
        "Usage: cartographer inspect-fallback instagram.com <fallback-id>",
      );
    }
    const result = await createFallbackReviewer().inspect(
      domain,
      fallbackTapeId,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "create-promotion-review") {
    const domain = parseDomain(args[0]);
    const fallbackTapeId = args[1];
    if (!fallbackTapeId) {
      throw new Error(
        "Usage: cartographer create-promotion-review instagram.com <fallback-id>",
      );
    }
    const artifacts = await createPromotionReviewArtifacts({
      domain,
      fallbackTapeId,
      fallbackStore: new JsonFallbackTapeStore(),
      tapeStore: new JsonTapeStore(),
    });
    console.log(
      JSON.stringify(
        {
          reviewPath: artifacts.reviewPath,
          reviewRequestPath: artifacts.reviewRequestPath,
          decisionSchemaPath: artifacts.decisionSchemaPath,
          decisionTemplatePath: artifacts.decisionTemplatePath,
          applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "review-task") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const taskId = String(parsed.args.taskId || "");
    if (!taskId) {
      throw new Error(
        "Usage: cartographer review-task instagram.com --task-id <task-id>",
      );
    }
    const taskStore = new JsonTaskStore();
    const fallbackStore = new JsonFallbackTapeStore();
    const materialized = await materializeRecordingSegments({
      domain,
      taskId,
      taskStore,
      fallbackStore,
    });
    const gate = await taskStore.canReviewTask(domain, taskId);
    if (!gate.allowed) {
      printGateFailure(gate, { taskId });
      return;
    }
    const artifacts = await createTaskPromotionReviewArtifacts({
      domain,
      taskId,
      taskStore,
      fallbackStore,
      tapeStore: new JsonTapeStore(),
    });
    console.log(
      JSON.stringify(
        {
          reviewPath: artifacts.reviewPath,
          reviewRequestPath: artifacts.reviewRequestPath,
          decisionSchemaPath: artifacts.decisionSchemaPath,
          decisionTemplatePath: artifacts.decisionTemplatePath,
          evidenceGuide:
            "Read reviewPath first. It lists fallback review files, candidate slices, operation evidence paths, and selector candidates.",
          fallbackReviews: artifacts.request.fallbacks.map((fallback) => ({
            fallbackTapeId: fallback.fallbackTapeId,
            intent: fallback.intent,
            reviewPath: fallback.reviewPath,
            reviewRequestPath: fallback.reviewRequestPath,
          })),
          materialized,
          applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "apply-promotion-decision") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const decisionFile = String(parsed.args.decisionFile || "");
    if (!decisionFile) {
      throw new Error(
        "Usage: cartographer apply-promotion-decision instagram.com --decision-file <decision.json>",
      );
    }
    const decision = await readPromotionDecisionFile(
      path.resolve(process.cwd(), decisionFile),
    );
    const fallbackStore = new JsonFallbackTapeStore();
    const applier = createPromotionDecisionApplier(fallbackStore);
    const decisions =
      decision.action === "review_batch" ? decision.decisions : [decision];
    const taskStore = new JsonTaskStore();
    if (decision.action !== "review_batch") {
      const tape = await fallbackStore.load(domain, decision.fallbackTapeId);
      if (tape?.taskId) {
        printGateFailure(
          {
            allowed: false,
            requiredAction: "review_task",
            reason:
              "Task-scoped fallback decisions must use a review_batch decision created from review-task.",
            command: `node packages/cartographer/dist/cli.js review-task ${domain} --task-id ${tape.taskId}`,
          },
          { taskId: tape.taskId, fallbackTapeId: tape.id },
        );
        return;
      }
    }
    if (decision.action === "review_batch") {
      const gate = await taskStore.canApplyTaskDecision(
        domain,
        decision.taskId,
        decisions.map((item) => item.fallbackTapeId),
      );
      if (!gate.allowed) {
        printGateFailure(gate, { taskId: decision.taskId });
        return;
      }
    }
    const results = [];
    const segmentTerminalStatus = new Map<
      string,
      "promoted" | "rejected" | "deleted"
    >();
    const singleDecisionSegmentUpdates: Array<{
      taskId: string;
      segmentId: string;
      status: "promoted" | "rejected" | "deleted";
    }> = [];
    for (const item of decisions) {
      const tape = await fallbackStore.load(domain, item.fallbackTapeId);
      const result = await applier.apply(domain, item);
      if (tape?.taskId && tape.taskSegmentId) {
        const existing = segmentTerminalStatus.get(tape.taskSegmentId);
        const next =
          result.result.action === "promote"
            ? "promoted"
            : result.result.action === "reject"
              ? "rejected"
              : "deleted";
        segmentTerminalStatus.set(
          tape.taskSegmentId,
          existing === "promoted" || next === "promoted" ? "promoted" : next,
        );
        singleDecisionSegmentUpdates.push({
          taskId: tape.taskId,
          segmentId: tape.taskSegmentId,
          status: next,
        });
      }
      results.push(result);
    }
    if (decision.action === "review_batch") {
      for (const [segmentId, status] of segmentTerminalStatus.entries()) {
        await taskStore.markSegmentStatus({
          domain,
          taskId: decision.taskId,
          segmentId,
          status,
        });
      }
    } else {
      for (const update of singleDecisionSegmentUpdates) {
        await taskStore.markSegmentStatus({
          domain,
          taskId: update.taskId,
          segmentId: update.segmentId,
          status: update.status,
        });
      }
    }
    if (decision.action === "review_batch") {
      await taskStore.markReviewApplied({
        domain,
        taskId: decision.taskId,
      });
    }
    console.log(
      JSON.stringify(
        decision.action === "review_batch" ? { decision, results } : results[0],
        null,
        2,
      ),
    );
    return;
  }

  if (command === "promote-fallback") {
    const domain = parseDomain(args[0]);
    printDeprecatedMutationCommand({
      command: "promote-fallback",
      reason:
        "Direct promotion bypasses the typed PromotionDecision schema, duplicate review, operation slicing, and stateScope.",
      replacement: `node packages/cartographer/dist/cli.js create-promotion-review ${domain} <fallback-id>`,
      applyCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
    });
    return;
  }

  if (command === "reject-fallback") {
    const domain = parseDomain(args[0]);
    printDeprecatedMutationCommand({
      command: "reject-fallback",
      reason:
        "Direct rejection bypasses the typed PromotionDecision lifecycle and task review coverage checks.",
      replacement: `node packages/cartographer/dist/cli.js create-promotion-review ${domain} <fallback-id>`,
      applyCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
    });
    return;
  }

  if (command === "delete-fallback") {
    const domain = parseDomain(args[0]);
    printDeprecatedMutationCommand({
      command: "delete-fallback",
      reason:
        "Direct deletion bypasses the typed PromotionDecision lifecycle and task review coverage checks.",
      replacement: `node packages/cartographer/dist/cli.js create-promotion-review ${domain} <fallback-id>`,
      applyCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
    });
    return;
  }

  if (command === "cleanup-recordings") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    if (parsed.args.confirmDelete !== true) {
      throw new Error(
        "Usage: cartographer cleanup-recordings instagram.com --confirm-delete",
      );
    }
    const deleted = [];
    for (const dir of recordingDirs(domain)) {
      await fs.rm(dir, { recursive: true, force: true });
      deleted.push(dir);
    }
    console.log(
      JSON.stringify(
        {
          domain,
          deleted,
          preserved: [
            "process tapes",
            "catalog.json",
            "generated SKILL.md",
            "generated manifest.json",
            "emitted per-site CLI",
            "state-action-cache",
            "browser profiles",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "reset-skills") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    if (parsed.args.confirmDelete !== true) {
      throw new Error(
        "Usage: cartographer reset-skills instagram.com --confirm-delete",
      );
    }
    const result = await resetSkills(domain);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "scripted-dm") {
    const domain = parseDomain(args[0]);
    const parsed = parseRuntimeArgs(args.slice(1));
    const recipient = String(parsed.args.recipient || "va_rad_");
    if (recipient !== "va_rad_") {
      throw new Error("V1 safety gate only allows --recipient va_rad_");
    }
    const message = String(parsed.args.message || "");
    if (!message) {
      throw new Error(
        "Usage: cartographer scripted-dm instagram.com --recipient va_rad_ --message <text> --confirm-write",
      );
    }
    const assumeLoggedIn = parsed.args.assumeLoggedIn === true;
    const username = assumeLoggedIn
      ? undefined
      : process.env.INSTAGRAM_USERNAME;
    const password = assumeLoggedIn
      ? undefined
      : process.env.INSTAGRAM_PASSWORD;
    if (!assumeLoggedIn && (!username || !password)) {
      throw new Error(
        "Set INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD in the environment.",
      );
    }
    const session = await new StagehandBrowserSessionFactory().launch(domain, {
      browser: "local",
      cacheDir: `${cartographerHome()}/stagehand-cache`,
      headless: false,
      viewport: { width: 1288, height: 900 },
    });
    try {
      const process = await recordScriptedInstagramDm(
        session,
        new BasicStateIdentity(),
        new JsonTapeStore(),
        new JsonStateActionCache(),
        {
          username,
          password,
          recipient,
          message,
          confirmWrite: parsed.confirmWrite,
          assumeLoggedIn,
        },
      );
      console.log(
        `recorded ${domain} process ${process.name} with ${process.steps.length} step(s)`,
      );
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "run" || command === "exec-command") {
    const domain = parseDomain(args[0]);
    const commandOrProcessName = args[1];
    if (!commandOrProcessName) {
      throw new Error(
        command === "exec-command"
          ? "Usage: cartographer exec-command instagram.com <command>"
          : "Usage: cartographer run instagram.com <process>",
      );
    }
    const parsed = parseRuntimeArgs(args.slice(2));
    const tapeStore = new JsonTapeStore();
    const resolved = await resolveProcessForCommand({
      domain,
      commandOrProcessName,
      tapeStore,
    });
    const result = await runResolvedAcquiredCommand({
      domain,
      commandSurface: command,
      commandOrProcessName,
      resolved,
      rawCommandParts: args.slice(2),
      args: parsed.args,
      taskId: parsed.args.taskId ? String(parsed.args.taskId) : undefined,
      confirmWrite: parsed.confirmWrite,
      dryRun: parsed.dryRun,
      autoChain: parsed.args.autoChain === true,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function normalizeIntent(intent: string): string {
  return intent.trim().replace(/\s+/g, " ").toLowerCase();
}

async function ensureRecordingSegment(input: {
  domain: Domain;
  taskId: string;
  intent: string;
}): Promise<
  Awaited<ReturnType<JsonTaskStore["startFallbackSegment"]>>["segment"]
> {
  const taskStore = new JsonTaskStore();
  const task = await taskStore.loadTask(input.domain, input.taskId);
  if (!task) throw new Error(`Unknown task: ${input.taskId}`);
  if (task.status === "closed") {
    throw new Error(`Task is already closed: ${input.taskId}`);
  }
  const segments = await taskStore.segmentsForTask(input.domain, input.taskId);
  let activeSegment = [...segments]
    .reverse()
    .find((segment) => segment.status === "recording");
  const requestedIntent = input.intent.trim();
  if (
    activeSegment &&
    requestedIntent &&
    normalizeIntent(activeSegment.intent) !== normalizeIntent(requestedIntent)
  ) {
    await materializeRecordingSegments({
      domain: input.domain,
      taskId: input.taskId,
      taskStore,
      fallbackStore: new JsonFallbackTapeStore(),
      abandonEmptyReason: `intent changed from "${activeSegment.intent}" to "${requestedIntent}" before any Playwright CLI operation was recorded`,
    });
    activeSegment = undefined;
  }
  if (!activeSegment) {
    const started = await taskStore.startFallbackSegment({
      domain: input.domain,
      taskId: input.taskId,
      segmentIntent: requestedIntent || "playwright cli fallback",
    });
    activeSegment = started.segment;
  }
  return activeSegment;
}

async function runCartographerShell(session: {
  domain: Domain;
  taskId: string;
  intent: string;
}): Promise<void> {
  const context: ShellContext = {
    domain: session.domain,
    taskId: session.taskId,
    activeIntent: session.intent || "fallback",
    runtime: await createPreloadedRuntime(session.domain),
  };
  const rl = readline.createInterface({ input, output });
  console.log(
    JSON.stringify(
      {
        shell: "cartographer",
        domain: context.domain,
        taskId: context.taskId,
        intent: context.activeIntent,
        mode: input.isTTY ? "interactive" : "scripted",
        note: "Fallback commands run through a hot recorded playwright-cli session. Acquired commands reuse one preloaded runtime.",
      },
      null,
      2,
    ),
  );
  printShellHelp();
  try {
    const handleLine = async (rawLine: string): Promise<boolean> => {
      const line = rawLine.trim();
      if (!line) return true;
      const [rawCommand, ...rawArgs] = splitCommandLine(line);
      const command = normalizeShellCommand(rawCommand);
      try {
        if (command === "help") {
          printShellHelp();
          return true;
        }
        if (command === "exit") return false;
        if (command === "intent") {
          const nextIntent = rawArgs.join(" ").trim();
          if (!nextIntent) {
            console.log(`intent=${context.activeIntent}`);
            return true;
          }
          context.activeIntent = nextIntent;
          console.log(
            JSON.stringify({ success: true, intent: context.activeIntent }),
          );
          return true;
        }
        if (command === "status") {
          await printShellStatus(
            context.domain,
            context.taskId,
            context.activeIntent,
          );
          return true;
        }
        if (command === "review") {
          await printShellReview(context.domain, context.taskId);
          return true;
        }
        if (command === "complete") {
          await printShellComplete(context.domain, context.taskId, rawArgs);
          return false;
        }
        if (command === "plan") {
          await printShellPlan(context.domain, rawArgs[0] || "");
          return true;
        }
        if (command === "sleep") {
          const sleptMs = Number(rawArgs[0] || "1000");
          await sleep(sleptMs);
          console.log(JSON.stringify({ success: true, sleptMs }));
          return true;
        }
        if (command === "exec") {
          await runShellAcquiredCommand({
            context,
            commandOrProcessName: rawArgs[0] || "",
            rawArgs: rawArgs.slice(1),
          });
          return true;
        }
        if (command === "snapshot") {
          await runShellFallbackCommand({
            context,
            command: "snapshot",
            args: rawArgs.filter((arg) => arg !== "--raw"),
            raw: rawCommand === "sr" || rawArgs.includes("--raw"),
          });
          return true;
        }
        if (command === "press" && rawArgs.length >= 2) {
          await runShellFallbackCommand({
            context,
            command: "click",
            args: [rawArgs[0]],
          });
          await runShellFallbackCommand({
            context,
            command: "press",
            args: [rawArgs.slice(1).join(" ")],
          });
          return true;
        }
        if (isPlaywrightCliCommand(command)) {
          await runShellFallbackCommand({
            context,
            command,
            args: rawArgs,
          });
          return true;
        }
        await runShellAcquiredCommand({
          context,
          commandOrProcessName: rawCommand,
          rawArgs,
        });
        return true;
      } catch (error) {
        console.error(
          JSON.stringify(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
        return true;
      }
    };

    if (input.isTTY) {
      for (;;) {
        const keepGoing = await handleLine(
          await rl.question(shellPrompt(context.domain, context.taskId)),
        );
        if (!keepGoing) break;
      }
    } else {
      for await (const line of rl) {
        const keepGoing = await handleLine(line);
        if (!keepGoing) break;
      }
    }
  } finally {
    context.pwSession?.close();
    rl.close();
  }
}

interface ShellContext {
  domain: Domain;
  taskId: string;
  activeIntent: string;
  runtime: CartographerRuntime;
  pwSession?: RecordedPlaywrightCliSession;
}

function shellPrompt(domain: Domain, taskId: string): string {
  return `${domain}:${taskId.slice(0, 8)}> `;
}

function normalizeShellCommand(command: string): string {
  const aliases: Record<string, string> = {
    "?": "help",
    h: "help",
    q: "exit",
    quit: "exit",
    i: "intent",
    st: "status",
    s: "snapshot",
    sr: "snapshot",
    g: "goto",
    c: "click",
    f: "fill",
    t: "type",
    p: "press",
    w: "sleep",
    wait: "sleep",
    x: "exec",
    r: "review",
    done: "complete",
  };
  return aliases[command] || command;
}

function printShellHelp(): void {
  console.log(`shell commands:
  status | st
  intent <segment> | i <segment>
  snapshot [--raw] | s | sr
  goto <url-or-path> | g <url-or-path>
  click <selector-or-ref> | c <selector-or-ref>
  fill <selector-or-ref> <text> | f <selector-or-ref> <text>
  type <text> | t <text>
  press <key> | p <key>
  press <selector-or-ref> <key>  # expands to recorded click + press
  sleep [ms] | wait [ms] | w [ms]
  exec <acquired-command> [arg=value ...] | x <acquired-command> [arg=value ...]
  <acquired-command> [arg=value ...]
  plan <acquired-command>
  review | r
  complete | done
  exit | quit | q`);
}

async function runShellFallbackCommand(input: {
  context: ShellContext;
  command: string;
  args: string[];
  raw?: boolean;
}): Promise<void> {
  const segment = await ensureRecordingSegment({
    domain: input.context.domain,
    taskId: input.context.taskId,
    intent: input.context.activeIntent,
  });
  input.context.pwSession ??= await RecordedPlaywrightCliSession.open({
    domain: input.context.domain,
    taskId: input.context.taskId,
  });
  const result = await input.context.pwSession.run({
    domain: input.context.domain,
    taskId: input.context.taskId,
    segmentId: segment.segmentId,
    intent: segment.intent,
    command: input.command,
    args: normalizeShellFallbackArgs(input.command, input.args),
  });
  if (input.raw) {
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
    return;
  }
  printCompactFallbackResult(result, segment.segmentId);
}

function normalizeShellFallbackArgs(command: string, args: string[]): string[] {
  if (command === "goto" || command === "open") {
    const first = args[0];
    if (first?.startsWith("/")) {
      return [`https://www.instagram.com${first}`];
    }
  }
  if (command === "snapshot") {
    return args.filter((arg) => arg !== "--raw");
  }
  return args;
}

function printCompactFallbackResult(
  result: Awaited<ReturnType<typeof runRecordedPlaywrightCli>>,
  segmentId: string,
): void {
  const summary = result.operation.evidenceSummary;
  const lines = [
    `${result.success ? "ok" : "failed"} ${result.command} segment=${segmentId}`,
    summary?.urlAfter ? `url: ${summary.urlAfter}` : undefined,
    summary?.title ? `title: ${summary.title}` : undefined,
  ].filter((line): line is string => Boolean(line));
  console.log(lines.join("\n"));
  if (summary?.controls.length) {
    console.log("refs:");
    for (const control of summary.controls.slice(0, 24)) {
      const label = [control.ref, control.role, quoted(control.name)]
        .filter(Boolean)
        .join(" ");
      console.log(`  ${label}${control.href ? ` -> ${control.href}` : ""}`);
    }
  }
  if (summary?.warnings.length) {
    console.log(`warnings: ${summary.warnings.join(", ")}`);
  }
  if (result.operation.evidenceSummaryPath) {
    console.log(`summary: ${result.operation.evidenceSummaryPath}`);
  }
  if (result.operation.evidencePaths?.snapshot) {
    console.log(`raw: ${result.operation.evidencePaths.snapshot}`);
  }
  if (!result.success && result.operation.failureReason) {
    console.log(`failure: ${result.operation.failureReason}`);
  }
}

function quoted(value: string | undefined): string {
  return value ? JSON.stringify(value) : "";
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, Number.isFinite(milliseconds) ? milliseconds : 1000),
  );
}

async function runShellAcquiredCommand(input: {
  context: ShellContext;
  commandOrProcessName: string;
  rawArgs: string[];
}): Promise<void> {
  if (!input.commandOrProcessName) {
    throw new Error("Usage: exec <acquired-command> [arg=value ...]");
  }
  const tapeStore = new JsonTapeStore();
  const resolved = await resolveProcessForCommand({
    domain: input.context.domain,
    commandOrProcessName: input.commandOrProcessName,
    tapeStore,
  });
  const parsed = parseShellRuntimeArgs(input.rawArgs, resolved.process.args);
  const result = await runResolvedAcquiredCommand({
    domain: input.context.domain,
    commandSurface: "shell",
    commandOrProcessName: input.commandOrProcessName,
    resolved,
    rawCommandParts: ["exec", input.commandOrProcessName, ...input.rawArgs],
    args: { ...parsed.args, taskId: input.context.taskId },
    taskId: input.context.taskId,
    confirmWrite: parsed.confirmWrite,
    dryRun: parsed.dryRun,
    autoChain: parsed.args.autoChain === true,
    runtime: input.context.runtime,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runResolvedAcquiredCommand(input: {
  domain: Domain;
  commandSurface: string;
  commandOrProcessName: string;
  resolved: Awaited<ReturnType<typeof resolveProcessForCommand>>;
  rawCommandParts: string[];
  args: Record<string, string | boolean>;
  taskId?: string;
  confirmWrite: boolean;
  dryRun: boolean;
  autoChain: boolean;
  runtime?: CartographerRuntime;
}): Promise<RunProcessResult & { autoChain?: unknown }> {
  const runtimeArgs = { ...input.args };
  delete runtimeArgs.autoChain;
  const runtime = input.runtime || (await createPreloadedRuntime(input.domain));
  let result = await runtime.runProcess({
    domain: input.domain,
    processName: input.resolved.processName,
    args: runtimeArgs,
    taskId: input.taskId,
    confirmWrite: input.confirmWrite,
    dryRun: input.dryRun,
  });
  await appendCliOperationToActiveSegment({
    domain: input.domain,
    taskId: input.taskId,
    command: acquiredCommandJournalLine(input),
    processName: input.resolved.processName,
    writesToPlatform: input.resolved.writesToPlatform,
    result,
  });
  if (
    !input.autoChain ||
    result.success ||
    result.failure?.kind !== "precondition_failed" ||
    !result.suggestedAutoEnterProcessName
  ) {
    return result;
  }

  const tapeStore = new JsonTapeStore();
  const catalog = await tapeStore.loadCatalog(input.domain);
  if (!catalog) return result;
  const plan = new SimpleStateScopedSkillPlanner().plan({
    domain: input.domain,
    targetProcessName: input.resolved.processName,
    catalog,
  });
  const preconditionSteps = plan.steps.filter(
    (step) => step.source === "precondition",
  );
  if (!plan.success || !preconditionSteps.length) {
    return {
      ...result,
      autoChain: {
        attempted: true,
        success: false,
        reason: plan.reason,
        plan,
      },
    };
  }

  const chainResults: RunProcessResult[] = [];
  for (const step of preconditionSteps) {
    const process = catalog.processes[step.processName];
    if (!process) {
      return {
        ...result,
        autoChain: {
          attempted: true,
          success: false,
          reason: `Missing chain command: ${step.processName}`,
          plan,
          chainResults,
        },
      };
    }
    if (process.writesToPlatform) {
      return {
        ...result,
        autoChain: {
          attempted: true,
          success: false,
          reason: `Refusing auto-chain through write-capable command: ${step.processName}`,
          plan,
          chainResults,
        },
      };
    }
    const chainResult = await runtime.runProcess({
      domain: input.domain,
      processName: step.processName,
      args: runtimeArgs,
      taskId: input.taskId,
      confirmWrite: input.confirmWrite,
      dryRun: input.dryRun,
    });
    chainResults.push(chainResult);
    await appendCliOperationToActiveSegment({
      domain: input.domain,
      taskId: input.taskId,
      command: [
        "cartographer",
        input.commandSurface,
        input.domain,
        "--auto-chain",
        step.processName,
      ].join(" "),
      processName: step.processName,
      writesToPlatform: process.writesToPlatform,
      result: chainResult,
    });
    if (!chainResult.success) {
      return {
        ...result,
        autoChain: {
          attempted: true,
          success: false,
          reason: `Chain command failed: ${step.processName}`,
          plan,
          chainResults,
        },
      };
    }
  }

  result = await runtime.runProcess({
    domain: input.domain,
    processName: input.resolved.processName,
    args: runtimeArgs,
    taskId: input.taskId,
    confirmWrite: input.confirmWrite,
    dryRun: input.dryRun,
  });
  await appendCliOperationToActiveSegment({
    domain: input.domain,
    taskId: input.taskId,
    command: `${acquiredCommandJournalLine(input)} --auto-chain-retry`,
    processName: input.resolved.processName,
    writesToPlatform: input.resolved.writesToPlatform,
    result,
  });
  return {
    ...result,
    autoChain: {
      attempted: true,
      success: result.success,
      plan,
      chainResults,
    },
  };
}

function acquiredCommandJournalLine(input: {
  domain: Domain;
  commandSurface: string;
  commandOrProcessName: string;
  rawCommandParts: string[];
}): string {
  return [
    "cartographer",
    input.commandSurface,
    input.domain,
    input.commandOrProcessName,
    ...input.rawCommandParts,
  ].join(" ");
}

function parseShellRuntimeArgs(
  rawArgs: string[],
  processArgs: ProcessArg[],
): {
  args: Record<string, string | boolean>;
  confirmWrite: boolean;
  dryRun: boolean;
} {
  const args: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let confirmWrite = false;
  let dryRun = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === "--confirm-write") {
      confirmWrite = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = flagNameToArgName(token.slice(2));
      const next = rawArgs[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
      continue;
    }
    const equalIndex = token.indexOf("=");
    if (equalIndex > 0) {
      args[flagNameToArgName(token.slice(0, equalIndex))] = token.slice(
        equalIndex + 1,
      );
      continue;
    }
    positionals.push(token);
  }
  for (const processArg of processArgs) {
    if (args[processArg.name] !== undefined) continue;
    const value = positionals.shift();
    if (value !== undefined) args[processArg.name] = value;
  }
  return { args, confirmWrite, dryRun };
}

function flagNameToArgName(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

async function printShellStatus(
  domain: Domain,
  taskId: string,
  intent: string,
): Promise<void> {
  const taskStore = new JsonTaskStore();
  const task = await taskStore.loadTask(domain, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const segments = await taskStore.segmentsForTask(domain, taskId);
  const reviewGate = await taskStore.canReviewTask(domain, taskId);
  const completeGate = await taskStore.canCompleteTask(domain, taskId);
  console.log(
    JSON.stringify(
      {
        success: true,
        domain,
        taskId,
        taskStatus: task.status,
        shellIntent: intent,
        activeSegment: [...segments]
          .reverse()
          .find((segment) => segment.status === "recording"),
        segmentCount: segments.length,
        learningDebt: segments.some((segment) =>
          ["recording", "materialized"].includes(segment.status),
        ),
        lifecycle: {
          canReview: reviewGate.allowed,
          canComplete: completeGate.allowed,
          next: reviewGate.allowed
            ? "review"
            : completeGate.allowed
              ? "complete"
              : completeGate.command || reviewGate.command,
        },
      },
      null,
      2,
    ),
  );
}

async function printShellReview(domain: Domain, taskId: string): Promise<void> {
  const taskStore = new JsonTaskStore();
  const fallbackStore = new JsonFallbackTapeStore();
  const materialized = await materializeRecordingSegments({
    domain,
    taskId,
    taskStore,
    fallbackStore,
  });
  const gate = await taskStore.canReviewTask(domain, taskId);
  if (!gate.allowed) {
    printGateFailure(gate, { taskId });
    return;
  }
  const artifacts = await createTaskPromotionReviewArtifacts({
    domain,
    taskId,
    taskStore,
    fallbackStore,
    tapeStore: new JsonTapeStore(),
  });
  console.log(
    JSON.stringify(
      {
        success: true,
        reviewPath: artifacts.reviewPath,
        reviewRequestPath: artifacts.reviewRequestPath,
        decisionSchemaPath: artifacts.decisionSchemaPath,
        decisionTemplatePath: artifacts.decisionTemplatePath,
        fallbackReviews: artifacts.request.fallbacks.map((fallback) => ({
          fallbackTapeId: fallback.fallbackTapeId,
          intent: fallback.intent,
          reviewPath: fallback.reviewPath,
        })),
        materialized,
        applyDecisionCommand: `node packages/cartographer/dist/cli.js apply-promotion-decision ${domain} --decision-file <decision.json>`,
      },
      null,
      2,
    ),
  );
}

async function printShellComplete(
  domain: Domain,
  taskId: string,
  rawArgs: string[],
): Promise<void> {
  const parsed = parseShellRuntimeArgs(rawArgs, []);
  const noAcquisitionReason = String(
    parsed.args.noAcquisitionReason || "",
  ).trim();
  const taskStore = new JsonTaskStore();
  const gate = await taskStore.canCompleteTask(domain, taskId, {
    noAcquisitionReason,
  });
  if (!gate.allowed) {
    printGateFailure(gate, { taskId });
    return;
  }
  const task = await taskStore.completeTask(domain, taskId, {
    noAcquisitionReason,
  });
  const browser = await closeTaskBrowser(domain, taskId);
  console.log(
    JSON.stringify(
      {
        success: true,
        taskId,
        status: task.status,
        taskPath: task.taskPath,
        taskMarkdownPath: task.taskMarkdownPath,
        completionKind: task.completionKind,
        completionReason: task.completionReason,
        browser,
      },
      null,
      2,
    ),
  );
}

async function printShellPlan(
  domain: Domain,
  commandOrProcessName: string,
): Promise<void> {
  if (!commandOrProcessName) {
    throw new Error("Usage: plan <acquired-command>");
  }
  const tapeStore = new JsonTapeStore();
  const resolved = await resolveProcessForCommand({
    domain,
    commandOrProcessName,
    tapeStore,
  });
  const catalog = await tapeStore.loadCatalog(domain);
  if (!catalog) throw new Error(`No tape catalog found for ${domain}`);
  const plan = new SimpleStateScopedSkillPlanner().plan({
    domain,
    targetProcessName: resolved.processName,
    catalog,
  });
  console.log(JSON.stringify(plan, null, 2));
}

async function resolveProcessForCommand(input: {
  domain: Domain;
  commandOrProcessName: string;
  tapeStore: JsonTapeStore;
}): Promise<{
  processName: string;
  writesToPlatform: boolean;
  process: TapeCatalog["processes"][string];
}> {
  const catalog = await input.tapeStore.loadCatalog(input.domain);
  if (!catalog) throw new Error(`No tape catalog found for ${input.domain}`);
  const direct = catalog.processes[input.commandOrProcessName];
  if (direct) {
    return {
      processName: direct.name,
      writesToPlatform: direct.writesToPlatform,
      process: direct,
    };
  }
  const slugMatch = Object.values(catalog.processes).find(
    (process) => slugifyName(process.name) === input.commandOrProcessName,
  );
  if (slugMatch) {
    return {
      processName: slugMatch.name,
      writesToPlatform: slugMatch.writesToPlatform,
      process: slugMatch,
    };
  }
  throw new Error(`Unknown command/process: ${input.commandOrProcessName}`);
}

async function teachInstagram(options?: {
  domain?: Domain;
  fallbackIntent?: string;
  reviewAtEnd?: boolean;
}): Promise<void> {
  const domain = options?.domain || "instagram.com";
  const factory = new StagehandBrowserSessionFactory();
  const session = await factory.launch(domain, {
    browser: "local",
    cacheDir: `${cartographerHome()}/stagehand-cache`,
    headless: false,
    viewport: { width: 1288, height: 900 },
  });
  const recorder = new ProcessTapeRecorder(
    session,
    new BasicStateIdentity(),
    new JsonTapeStore(),
    new JsonStateActionCache(),
  );

  console.log("Opened Instagram in a Stagehand local Chrome session.");
  console.log("Log in manually if needed, then use commands below.");
  if (options?.fallbackIntent) {
    console.log(`Fallback intent: ${options.fallbackIntent}`);
    console.log(
      `After recording steps, run: save-fallback [--write] [--arg message]`,
    );
  }
  printTeachHelp();

  const rl = readline.createInterface({ input, output });
  const recordedStepIds: string[] = [];
  try {
    for (;;) {
      const line = (await rl.question("cartographer> ")).trim();
      if (!line) continue;
      const [cmd, ...rest] = splitCommandLine(line);

      if (cmd === "help") {
        printTeachHelp();
      } else if (cmd === "snapshot") {
        const label = rest.join("-") || "snapshot";
        const state = await recorder.snapshot(label);
        console.log(
          `state ${state.id.slice(0, 10)} atoms=${state.atoms.length} url=${state.url}`,
        );
      } else if (cmd === "observe") {
        const instruction = rest.join(" ");
        if (!instruction) {
          console.log("Usage: observe <instruction>");
          continue;
        }
        const candidates = await recorder.observe(instruction);
        for (const candidate of candidates) {
          console.log(
            `${candidate.id} [${candidate.risk}] ${candidate.action.method || "?"} ${candidate.action.description}`,
          );
        }
      } else if (cmd === "act") {
        const candidateId = rest[0];
        if (!candidateId) {
          console.log("Usage: act <candidate-id>");
          continue;
        }
        const result = await recorder.act(candidateId);
        console.log(`${result.success ? "ok" : "failed"} ${result.message}`);
      } else if (cmd === "record-step") {
        const name = rest.find((part) => !part.startsWith("--"));
        if (!name) {
          console.log("Usage: record-step <name> [--write]");
          continue;
        }
        const step = await recorder.recordLastStep(name, {
          writesToPlatform: rest.includes("--write"),
        });
        recordedStepIds.push(step.id);
        console.log(
          `step ${step.name} ${step.id.slice(0, 10)} write=${step.writesToPlatform}`,
        );
      } else if (cmd === "name-process") {
        const name = rest[0];
        if (!name) {
          console.log(
            "Usage: name-process <name> [step-id ...] [--write] [--arg message]",
          );
          continue;
        }
        const stepIds = rest.filter((part) => /^[a-f0-9]{64}$/.test(part));
        const argNames = collectFlagValues(rest, "--arg");
        const process = await recorder.nameProcess({
          name,
          description: name.replace(/_/g, " "),
          stepIds: stepIds.length ? stepIds : recordedStepIds,
          args: argNames.map(
            (argName): ProcessArg => ({
              name: argName,
              required: true,
              description: `${argName} argument`,
            }),
          ),
          writesToPlatform: rest.includes("--write"),
        });
        console.log(
          `process ${process.name} steps=${process.steps.length} write=${process.writesToPlatform}`,
        );
      } else if (cmd === "save-fallback") {
        const argNames = collectFlagValues(rest, "--arg");
        const intent =
          collectFreeText(rest, ["--arg", "--write"]) ||
          options?.fallbackIntent;
        if (!intent) {
          console.log(
            "Usage: save-fallback <intent> [step-id ...] [--write] [--arg message]",
          );
          continue;
        }
        const stepIds = rest.filter((part) => /^[a-f0-9]{64}$/.test(part));
        const steps = recorder.getRecordedSteps(
          stepIds.length ? stepIds : recordedStepIds,
        );
        const fallback = await saveFallbackTape({
          domain,
          intent,
          steps,
          argNames,
          writesToPlatform:
            rest.includes("--write") ||
            steps.some((step) => step.writesToPlatform),
        });
        console.log(
          `fallback ${fallback.id.slice(0, 10)} steps=${fallback.steps.length} write=${fallback.writesToPlatform}`,
        );
      } else if (cmd === "save") {
        const catalog = await recorder.save();
        console.log(
          `saved ${Object.keys(catalog.processes).length} process(es)`,
        );
      } else if (cmd === "emit-cli") {
        const result = await new NodeCliEmitter().emit({
          domain: "instagram.com",
          tapeDir: tapeDir("instagram.com"),
          outputPath: `${binDir()}/instagram-com-cli`,
          binName: "instagram-com-cli",
        });
        console.log(`emitted ${result.outputPath}`);
      } else if (cmd === "quit" || cmd === "exit") {
        break;
      } else {
        console.log(`Unknown teach command: ${cmd}`);
      }
    }
  } finally {
    rl.close();
    await session.close();
  }

  if (options?.reviewAtEnd) {
    const result = await createFallbackReviewer().review(domain);
    console.log(JSON.stringify({ endOfTaskReview: result }, null, 2));
  }
}

function printHelp(): void {
  console.log(`cartographer commands:
  cg use instagram --task "<task>"
  cg shell instagram --task-id <task-id> [--intent <segment>]
  cg exec-command instagram <command> [--task-id <task-id>] [--auto-chain] [--dry-run] [--confirm-write] [--key value]

  cartographer begin-task instagram.com --intent <task>
	  cartographer use instagram.com --task "<task>" [--intent <segment>]
	  cartographer shell instagram.com --task-id <task-id> [--intent <segment>]
	  cartographer show-task instagram.com --task-id <task-id>
	  cartographer task-summary instagram.com --task-id <task-id>
	  cartographer pw instagram.com --task-id <task-id> [--intent <segment>] <playwright-cli-command> [args...]
	  cartographer abandon-segment instagram.com --task-id <task-id> --segment-id <segment-id> --reason <reason>
	  cartographer emit-cli instagram.com
	  cartographer emit-skill instagram.com
	  cartographer emit-manifest instagram.com
	  cartographer expose-skills instagram.com [--home-only]
  cartographer plan instagram.com <process-name>
	  cartographer exec-command instagram.com <command> [--task-id <task-id>] [--auto-chain] [--dry-run] [--confirm-write] [--key value]
	  cartographer run instagram.com <process-name> [--task-id <task-id>] [--auto-chain] [--dry-run] [--confirm-write] [--key value]
	  cartographer review-fallbacks instagram.com
	  cartographer review-task instagram.com --task-id <task-id>
	  cartographer complete-task instagram.com --task-id <task-id> [--no-acquisition-reason <reason>]
	  cartographer inspect-fallback instagram.com <fallback-id>
	  cartographer create-promotion-review instagram.com <fallback-id>
	  cartographer apply-promotion-decision instagram.com --decision-file <decision.json>
	  cartographer cleanup-recordings instagram.com --confirm-delete
	  cartographer reset-skills instagram.com --confirm-delete`);
}

function printTeachHelp(): void {
  console.log(`teach commands:
  snapshot <label>
  observe <instruction>
  act <candidate-id>
  record-step <name> [--write]
  name-process <name> [step-id ...] [--write] [--arg message]
  save-fallback <intent> [step-id ...] [--write] [--arg message]
  save
  emit-cli
  quit`);
}

function parseDomain(value: string | undefined): Domain {
  if (value === "instagram.com" || value === "instagram")
    return "instagram.com";
  throw new Error(
    "Only instagram.com is supported in v1. Use instagram or instagram.com.",
  );
}

function parsePwArgs(argv: string[]): {
  taskId: string;
  intent?: string;
  json: boolean;
  command: string;
  commandArgs: string[];
} {
  let taskId = "";
  let intent: string | undefined;
  let json = false;
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--task-id") {
      taskId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--intent") {
      intent = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    passthrough.push(token);
  }
  return {
    taskId,
    intent,
    json,
    command: passthrough[0] || "",
    commandArgs: passthrough.slice(1),
  };
}

function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of line) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function collectFlagValues(parts: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === flag && parts[index + 1]) {
      values.push(parts[index + 1]);
      index += 1;
    }
  }
  return values;
}

function printGateFailure(
  gate: TaskLifecycleGateResult,
  context: Record<string, unknown> = {},
): void {
  process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        success: false,
        ...context,
        requiredAction: gate.requiredAction,
        reason: gate.reason,
        command: gate.command,
      },
      null,
      2,
    ),
  );
}

function printDeprecatedMutationCommand(input: {
  command: string;
  reason: string;
  requiredAction?: string;
  replacement: string;
  applyCommand: string;
}): void {
  process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        success: false,
        deprecated: true,
        command: input.command,
        reason: input.reason,
        requiredAction: input.requiredAction || "use_typed_promotion_decision",
        replacement: input.replacement,
        applyCommand: input.applyCommand,
      },
      null,
      2,
    ),
  );
}

function collectFreeText(parts: string[], flagsWithValue: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.startsWith("--")) {
      if (flagsWithValue.includes(part)) index += 1;
      continue;
    }
    if (/^[a-f0-9]{64}$/.test(part)) continue;
    values.push(part);
  }
  return values.join(" ").trim();
}

async function emitCli(domain: Domain) {
  return await new NodeCliEmitter().emit({
    domain,
    tapeDir: tapeDir(domain),
    outputPath: `${binDir()}/instagram-com-cli`,
    binName: "instagram-com-cli",
  });
}

async function emitCartographerShortcut(): Promise<string> {
  const outputPath = path.join(binDir(), "cg");
  const cliPath = path.resolve(
    process.cwd(),
    "packages/cartographer/dist/cli.js",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(cliPath).href)};\n`,
    {
      encoding: "utf8",
      mode: 0o755,
    },
  );
  await fs.chmod(outputPath, 0o755);
  return outputPath;
}

async function resetSkills(domain: Domain) {
  const now = new Date().toISOString();
  const catalog: TapeCatalog = {
    domain,
    version: 1,
    processes: {},
    updatedAt: now,
  };
  const generatedSkillDir = path.resolve(
    process.cwd(),
    "packages",
    "cartographer",
    "skills",
    domain,
  );
  const removed = [
    tapeDir(domain),
    path.join(siteDir(domain), "skills"),
    path.join(siteDir(domain), "promotions"),
    skillPath(domain),
    manifestPath(domain),
    path.join(binDir(), "instagram-com-cli"),
    generatedSkillDir,
  ];

  for (const target of removed) {
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.mkdir(siteDir(domain), { recursive: true });
  await fs.writeFile(
    catalogPath(domain),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  const homeSkillPath = await emitSkillMd(domain);
  const homeManifestPath = await emitSkillManifest(domain);
  const repoSkillPath = await emitSkillMd(
    domain,
    path.join(generatedSkillDir, "SKILL.md"),
  );
  const repoManifestPath = await emitSkillManifest(
    domain,
    path.join(generatedSkillDir, "manifest.json"),
  );
  const cli = await emitCli(domain);

  return {
    domain,
    catalogPath: catalogPath(domain),
    commandCount: 0,
    removed,
    generated: {
      homeSkillPath,
      homeManifestPath,
      repoSkillPath,
      repoManifestPath,
      cliPath: cli.outputPath,
    },
  };
}

function createFallbackReviewer(): DefaultFallbackReviewer {
  return new DefaultFallbackReviewer(
    new JsonFallbackTapeStore(),
    new JsonTapeStore(),
    new ConsoleCartographerLogger(),
  );
}

function createEndOfTaskReviewer(): DefaultEndOfTaskReviewer {
  const fallbackStore = new JsonFallbackTapeStore();
  const logger = new ConsoleCartographerLogger();
  return new DefaultEndOfTaskReviewer(
    new DefaultFallbackReviewer(fallbackStore, new JsonTapeStore(), logger),
    fallbackStore,
    logger,
  );
}

function createPromotionDecisionApplier(
  fallbackStore = new JsonFallbackTapeStore(),
): DefaultPromotionDecisionApplier {
  return new DefaultPromotionDecisionApplier(
    fallbackStore,
    new DefaultSkillPromoter(
      fallbackStore,
      new JsonPromotionStore(),
      new JsonTapeStore(),
      new ConsoleCartographerLogger(),
    ),
  );
}

async function saveFallbackTape(input: {
  domain: Domain;
  intent: string;
  steps: TapeStep[];
  argNames: string[];
  writesToPlatform: boolean;
}) {
  const now = new Date().toISOString();
  const argNames = unique([
    ...input.argNames,
    ...placeholderArgNames(input.steps),
  ]);
  const tape = {
    id: sha256({
      domain: input.domain,
      intent: input.intent,
      stepIds: input.steps.map((step) => step.id),
      createdAt: now,
    }),
    domain: input.domain,
    intent: input.intent,
    source: "stagehand_fallback" as const,
    status: "succeeded" as const,
    entry: input.steps[0].before,
    steps: input.steps,
    operations: input.steps.map((step, index) => ({
      id: sha256({
        domain: input.domain,
        intent: input.intent,
        stepId: step.id,
        operationIndex: index,
        createdAt: now,
      }),
      kind: "record_step" as const,
      instruction: `record-step ${step.name}`,
      urlBefore: step.before.url,
      urlAfter: step.after.url,
      selector: step.actions[0]?.selector,
      selectorKind: classifySelector(step.actions[0]?.selector || ""),
      stepId: step.id,
      writesToPlatform: step.writesToPlatform,
      createdAt: now,
    })),
    evidence: [] as EvidenceArtifact[],
    args: argNames.map((argName) => ({
      name: argName,
      required: true,
      description: `${argName} argument`,
    })),
    writesToPlatform: input.writesToPlatform,
    recordingStartedAt: now,
    createdAt: now,
    completedAt: now,
  };
  await new JsonFallbackTapeStore().save(tape);
  return tape;
}

function classifySelector(
  selector: string,
): "xpath" | "css" | "url" | "playwright" | "unknown" {
  return classifyCartographerSelector(selector);
}

function placeholderArgNames(steps: TapeStep[]): string[] {
  return steps.flatMap((step) =>
    step.actions.flatMap((action) =>
      (action.arguments || []).flatMap((arg) =>
        [...arg.matchAll(/%([a-zA-Z][a-zA-Z0-9_]*)%/g)].map(
          (match) => match[1],
        ),
      ),
    ),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
