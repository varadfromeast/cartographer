import type {
  ProcessName,
  ProcessTapeSummary,
  SkillChainPlan,
  StateScopedSkillPlanner,
} from "./contracts.js";

export class SimpleStateScopedSkillPlanner implements StateScopedSkillPlanner {
  plan(input: Parameters<StateScopedSkillPlanner["plan"]>[0]): SkillChainPlan {
    const target = input.catalog.processes[input.targetProcessName];
    if (!target) {
      return {
        success: false,
        domain: input.domain,
        targetProcessName: input.targetProcessName,
        steps: [],
        fallbackRecommended: true,
        reason: `Unknown command: ${input.targetProcessName}`,
      };
    }

    const chain = this.buildChain(input.catalog.processes, target, new Set());
    if (!chain.success) {
      return {
        success: false,
        domain: input.domain,
        targetProcessName: target.name,
        steps: chain.steps,
        fallbackRecommended: true,
        reason: chain.reason,
      };
    }

    return {
      success: true,
      domain: input.domain,
      targetProcessName: target.name,
      steps: chain.steps,
      fallbackRecommended: false,
      reason:
        chain.steps.length > 1
          ? "Run the suggested precondition command(s), then the target command."
          : "Target command has no declared state precondition.",
    };
  }

  private buildChain(
    processes: Record<ProcessName, ProcessTapeSummary>,
    target: ProcessTapeSummary,
    seen: Set<ProcessName>,
  ): { success: boolean; steps: SkillChainPlan["steps"]; reason: string } {
    if (seen.has(target.name)) {
      return {
        success: false,
        steps: [],
        reason: `State-scope cycle detected at ${target.name}`,
      };
    }
    seen.add(target.name);

    const autoEnter = target.stateScope?.autoEnterProcessName;
    if (!target.stateScope?.preconditions?.length || !autoEnter) {
      return {
        success: true,
        steps: [
          {
            processName: target.name,
            source: "target",
            reason: "target command",
          },
        ],
        reason: "no precondition chain required",
      };
    }

    const precondition = processes[autoEnter];
    if (!precondition) {
      return {
        success: false,
        steps: [],
        reason: `Missing auto-enter command: ${autoEnter}`,
      };
    }

    const prefix = this.buildChain(processes, precondition, seen);
    return {
      success: prefix.success,
      steps: [
        ...prefix.steps.map((step) => ({
          ...step,
          source: "precondition" as const,
        })),
        {
          processName: target.name,
          source: "target",
          reason: `requires state reached by ${autoEnter}`,
        },
      ],
      reason: prefix.success ? "precondition chain suggested" : prefix.reason,
    };
  }
}
