import type {
  CartographerLogger,
  Domain,
  LoadedSkillset,
  ProcessName,
  ProcessTape,
  ProcessTapeSummary,
  PromotionReplayResult,
  SkillRegistry,
  TaskId,
} from "./contracts.js";
import { PlaywrightBrowserSessionFactory } from "./browser-session.js";
import { JsonStateActionCache } from "./state-action-cache.js";
import { ConsoleCartographerLogger } from "./logger.js";
import { ProcessTapeRuntime } from "./runtime.js";
import { BasicStateIdentity } from "./state-identity.js";
import { TaskScopedBrowserSessionFactory } from "./task-browser.js";

export async function replayBeforePromotion(input: {
  domain: Domain;
  process: ProcessTape;
  taskId?: TaskId;
  logger?: CartographerLogger;
}): Promise<PromotionReplayResult> {
  const logger = input.logger || new ConsoleCartographerLogger();
  if (input.process.writesToPlatform) {
    return {
      status: "skipped",
      reason:
        "write-capable promotions are not auto-replayed because replay may send, save, delete, or publish data",
      processName: input.process.name,
      taskId: input.taskId,
    };
  }
  if (input.process.args.length) {
    return {
      status: "skipped",
      reason:
        "promotion replay needs runtime argument samples; this process declares args",
      processName: input.process.name,
      taskId: input.taskId,
    };
  }

  const runtime = new ProcessTapeRuntime(
    new TaskScopedBrowserSessionFactory(new PlaywrightBrowserSessionFactory()),
    new BasicStateIdentity(),
    new SingleProcessRegistry(input.process),
    new JsonStateActionCache(),
    undefined,
    logger,
  );
  const result = await runtime.runProcess({
    domain: input.domain,
    processName: input.process.name,
    taskId: input.taskId,
    args: {},
    confirmWrite: false,
    dryRun: false,
  });
  if (!result.success) {
    throw new Error(
      `Promotion replay failed for ${input.process.name}: ${result.message}`,
    );
  }
  return {
    status: "passed",
    reason: "non-write command replayed successfully before promotion",
    processName: input.process.name,
    taskId: input.taskId,
    postconditionsPassed: result.postconditions?.passed,
    executedStepCount: result.execution?.executedStepCount,
  };
}

class SingleProcessRegistry implements SkillRegistry {
  constructor(private readonly process: ProcessTape) {}

  async preload(domain: Domain): Promise<LoadedSkillset> {
    return this.skillset(domain);
  }

  async refresh(domain: Domain): Promise<LoadedSkillset> {
    return this.skillset(domain);
  }

  async getProcess(
    domain: Domain,
    name: ProcessName,
  ): Promise<ProcessTape | null> {
    if (domain !== this.process.domain || name !== this.process.name)
      return null;
    return this.process;
  }

  async listProcesses(domain: Domain): Promise<ProcessTapeSummary[]> {
    return domain === this.process.domain ? [this.summary()] : [];
  }

  private skillset(domain: Domain): LoadedSkillset {
    return {
      domain,
      catalog: {
        domain,
        version: 1,
        processes:
          domain === this.process.domain
            ? { [this.process.name]: this.summary() }
            : {},
        updatedAt: new Date().toISOString(),
      },
      processes:
        domain === this.process.domain
          ? { [this.process.name]: this.process }
          : {},
      loadedAt: new Date().toISOString(),
    };
  }

  private summary(): ProcessTapeSummary {
    return {
      name: this.process.name,
      description: this.process.description,
      stepCount: this.process.steps.length,
      writesToPlatform: this.process.writesToPlatform,
      args: this.process.args,
      outputs: this.process.outputs,
      stateScope: this.process.stateScope,
      postconditions: this.process.postconditions,
      updatedAt: this.process.updatedAt,
    };
  }
}
