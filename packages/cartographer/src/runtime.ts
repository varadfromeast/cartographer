import type {
  Action,
  BrowserSession,
  BrowserSessionFactory,
  CartographerLogger,
  CartographerRuntime,
  ActionFailure,
  DriftReport,
  DriftStepReport,
  PostconditionResult,
  ProcessTape,
  ReplayValidator,
  RunFailure,
  RunProcessInput,
  RunProcessResult,
  RuntimeArgs,
  SkillRegistry,
  State,
  StateActionCache,
  StateFingerprint,
  StateIdentity,
  StepSelectorDiagnostics,
  StepValidator,
  ValidationCheck,
  ValidationResult,
  VisualReviewArtifact,
} from "./contracts.js";
import { appendJsonLine } from "./fs-json.js";
import { sha256 } from "./hash.js";
import { ConsoleCartographerLogger } from "./logger.js";
import { auditPath, cartographerHome } from "./paths.js";
import { shapeUrl } from "./state-identity.js";
import { waitForLoginIfNeeded } from "./login-wait.js";
import { getSiteConfig, type SiteConfig } from "./site-config.js";
import { createPendingVisualReview } from "./visual-review.js";

const REPLAY_ACTION_TIMEOUT_MS = 20_000;

export class ProcessTapeRuntime implements CartographerRuntime {
  constructor(
    private readonly sessionFactory: BrowserSessionFactory,
    private readonly identity: StateIdentity,
    private readonly skillRegistry: SkillRegistry,
    private readonly actionCache: StateActionCache,
    private readonly replayValidator: ReplayValidator = new DefaultReplayValidator(),
    private readonly logger: CartographerLogger = new ConsoleCartographerLogger(),
    private readonly siteConfigFor: (
      domain: RunProcessInput["domain"],
    ) => SiteConfig = getSiteConfig,
  ) {}

  async runProcess(input: RunProcessInput): Promise<RunProcessResult> {
    this.logger.log("info", "runtime.start", {
      domain: input.domain,
      processName: input.processName,
      dryRun: input.dryRun,
      confirmWrite: input.confirmWrite,
    });
    const process = await this.skillRegistry.getProcess(
      input.domain,
      input.processName,
    );
    if (!process) {
      this.logger.log("error", "runtime.unknown_process", {
        processName: input.processName,
      });
      return failureResult(input.processName, 0, {
        kind: "unknown_process",
        reason: `Unknown process tape: ${input.processName}`,
      });
    }
    const missingArgs = findMissingRequiredArgs(process, input.args);
    if (missingArgs.length) {
      this.logger.log("warn", "runtime.missing_args", {
        processName: process.name,
        missingArgs,
      });
      return failureResult(input.processName, process.steps.length, {
        kind: "missing_args",
        reason: `Missing required arg(s): ${missingArgs.join(", ")}`,
      });
    }
    if (process.writesToPlatform && !input.confirmWrite && !input.dryRun) {
      this.logger.log("warn", "runtime.write_without_confirmation", {
        processName: process.name,
      });
      return failureResult(input.processName, process.steps.length, {
        kind: "write_confirmation_required",
        reason: "Refusing to run write process without --confirm-write",
      });
    }

    if (input.dryRun) {
      this.logger.log("info", "runtime.dry_run", {
        processName: process.name,
        stepCount: process.steps.length,
        writesToPlatform: process.writesToPlatform,
      });
      return {
        success: true,
        processName: input.processName,
        executedStepIds: [],
        driftedStepIds: [],
        execution: {
          completed: true,
          stepCount: process.steps.length,
          executedStepCount: 0,
          actionFailures: [],
        },
        postconditions: {
          required: Boolean(process.postconditions?.length),
          passed: true,
          checks: [],
        },
        drift: {
          detected: false,
          severity: "none",
          steps: [],
        },
        message: `Dry run: ${process.steps.length} step(s) would execute.`,
      };
    }

    this.logger.log("info", "browser.launch", { domain: input.domain });
    const session = await this.sessionFactory.launch(input.domain, {
      browser: "local",
      cacheDir: `${cartographerHome()}/browser-cache`,
      headless: false,
      viewport: { width: 1288, height: 900 },
      taskId: input.taskId,
    });

    const executedStepIds: string[] = [];
    const driftedStepIds: string[] = [];
    const actionFailures: ActionFailure[] = [];
    const driftSteps: DriftStepReport[] = [];
    const outputs: Record<string, string> = {};
    let preconditions: PostconditionResult = {
      required: Boolean(process.stateScope?.preconditions?.length),
      passed: true,
      checks: [],
    };
    let postconditions: PostconditionResult = {
      required: Boolean(process.postconditions?.length),
      passed: true,
      checks: [],
    };
    let visualReview: VisualReviewArtifact | undefined;
    try {
      if (input.taskId) {
        const currentUrl = await session.currentUrl();
        this.logger.log("info", "runtime.reuse_task_browser", {
          taskId: input.taskId,
          currentUrl,
        });
        if (isUninitializedBrowserUrl(currentUrl)) {
          this.logger.log("info", "runtime.goto_entry_from_blank_task_page", {
            taskId: input.taskId,
            url: process.entry.url,
          });
          await session.goto(process.entry.url);
          await waitForLoginIfNeeded(
            session,
            "Instagram login screen detected",
          );
        }
      } else {
        this.logger.log("info", "runtime.goto_entry", {
          url: process.entry.url,
        });
        await session.goto(process.entry.url);
        await waitForLoginIfNeeded(session, "Instagram login screen detected");
      }
      if (process.stateScope?.preconditions?.length) {
        const validation = await this.replayValidator.validate(
          session,
          bindValidators(process.stateScope.preconditions, input.args),
        );
        preconditions = {
          required: true,
          passed: validation.passed,
          checks: validation.checks || [],
        };
        this.logger.log(
          validation.passed ? "info" : "warn",
          "runtime.preconditions",
          {
            passed: validation.passed,
            failures: validation.failures,
            autoEnterProcessName: process.stateScope.autoEnterProcessName,
            onUnmetPrecondition: process.stateScope.onUnmetPrecondition,
          },
        );
        if (!validation.passed) {
          return {
            success: false,
            processName: input.processName,
            executedStepIds: [],
            driftedStepIds: [],
            outputs,
            execution: {
              completed: false,
              stepCount: process.steps.length,
              executedStepCount: 0,
              actionFailures,
            },
            preconditions,
            postconditions,
            drift: {
              detected: false,
              severity: "none",
              steps: [],
            },
            failure: {
              kind: "precondition_failed",
              reason: validation.failures.join("; "),
            },
            suggestedAutoEnterProcessName:
              process.stateScope.autoEnterProcessName,
            fallbackRecommended:
              process.stateScope.onUnmetPrecondition === "fallback",
            message:
              process.stateScope.autoEnterProcessName &&
              process.stateScope.onUnmetPrecondition === "suggest_chain"
                ? `Preconditions failed. Run ${process.stateScope.autoEnterProcessName} first or use fallback.`
                : "Preconditions failed. Use fallback for this segment.",
          };
        }
      }
      for (const step of process.steps) {
        let stepActionFailed = false;
        this.logger.log("info", "runtime.step.start", {
          processName: process.name,
          stepId: step.id,
          stepName: step.name,
          type: step.type,
          writesToPlatform: step.writesToPlatform,
        });
        if (step.writesToPlatform) {
          await appendJsonLine(auditPath(input.domain), {
            event: "before_write_step",
            processName: process.name,
            stepId: step.id,
            stepName: step.name,
            at: new Date().toISOString(),
          });
        }

        const cached = await this.actionCache.get({
          domain: input.domain,
          beforeStateId: step.before.id,
          atomId: step.atomId,
        });
        const actionCacheSafe = !step.actions.some(actionHasRuntimePlaceholder);
        const actions =
          actionCacheSafe && cached?.actions.length
            ? cached.actions
            : step.actions;
        this.logger.log(
          actionCacheSafe && cached?.actions.length ? "info" : "debug",
          "runtime.step.cache",
          {
            stepName: step.name,
            cacheHit: Boolean(actionCacheSafe && cached?.actions.length),
            cacheBypassed: !actionCacheSafe && Boolean(cached?.actions.length),
            actionCount: actions.length,
          },
        );
        for (const action of actions) {
          const boundAction = bindActionArgs(action, input.args);
          this.logger.log("debug", "runtime.action", {
            stepName: step.name,
            method: boundAction.method,
            selector: boundAction.selector,
          });
          const outcome = await executeActionWithSelectorFallbacks({
            session,
            action: boundAction,
            stepType: step.type,
            alternatives: step.selectorDiagnostics?.alternatives,
            siteConfig: this.siteConfigFor(input.domain),
            logger: this.logger,
          });
          await waitForLoginIfNeeded(
            session,
            "Instagram login screen detected",
          );
          if (!outcome.success) {
            const failure: ActionFailure = {
              stepId: step.id,
              stepName: step.name,
              method: boundAction.method,
              selector: outcome.selector || boundAction.selector,
              message: outcome.message,
              diagnosticScreenshotPath: outcome.diagnosticScreenshotPath,
            };
            actionFailures.push(failure);
            this.logger.log("error", "runtime.action.failed", { ...failure });
            stepActionFailed = true;
            break;
          }
        }
        if (stepActionFailed) break;
        executedStepIds.push(step.id);

        const after = await this.identity.capture(
          session,
          `after-${step.name}`,
        );
        const validation = await this.replayValidator.validate(
          session,
          bindValidators(step.validators, input.args),
        );
        const expectedFingerprint = comparableFingerprint(step.after);
        const observedFingerprint = comparableFingerprint(after);
        const fingerprintDrift =
          expectedFingerprint.hash !== observedFingerprint.hash;
        if (
          (fingerprintDrift &&
            !shouldSuppressFingerprintDrift(step, validation.passed)) ||
          !validation.passed
        ) {
          const diff = this.identity.diff(
            expectedFingerprint,
            observedFingerprint,
          );
          driftedStepIds.push(step.id);
          driftSteps.push({
            stepId: step.id,
            stepName: step.name,
            expected: expectedFingerprint,
            observed: observedFingerprint,
            stableAtomRatio: diff.stableAtomRatio,
            validationFailures: validation.failures,
            validationChecks: validation.checks || [],
          });
          this.logger.log("warn", "runtime.step.drift", {
            stepName: step.name,
            expectedHash: expectedFingerprint.hash,
            observedHash: observedFingerprint.hash,
            expectedUrlShape: expectedFingerprint.urlShape,
            observedUrlShape: observedFingerprint.urlShape,
            expectedAtomCount: expectedFingerprint.atomCount,
            observedAtomCount: observedFingerprint.atomCount,
            stableAtomRatio: diff.stableAtomRatio,
            failures: validation.failures,
          });
          await this.actionCache.markDrifted(
            {
              domain: input.domain,
              beforeStateId: step.before.id,
              atomId: step.atomId,
            },
            [
              `Expected ${expectedFingerprint.hash}, observed ${observedFingerprint.hash}`,
              ...validation.failures,
            ].join("; "),
          );
        }
        this.logger.log("info", "runtime.step.done", {
          stepName: step.name,
          drifted: driftedStepIds.includes(step.id),
        });

        if (step.writesToPlatform) {
          await appendJsonLine(auditPath(input.domain), {
            event: "after_write_step",
            processName: process.name,
            stepId: step.id,
            stepName: step.name,
            at: new Date().toISOString(),
            drifted: driftedStepIds.includes(step.id),
          });
        }
      }

      if (actionFailures.length === 0) {
        const validation = await this.replayValidator.validate(
          session,
          bindValidators(process.postconditions, input.args),
        );
        postconditions = {
          required: Boolean(process.postconditions?.length),
          passed: validation.passed,
          checks: validation.checks || [],
        };
        this.logger.log(
          validation.passed ? "info" : "warn",
          "runtime.postconditions",
          {
            required: postconditions.required,
            passed: postconditions.passed,
            failures: validation.failures,
          },
        );

        for (const output of process.outputs || []) {
          if (output.source === "text") {
            this.logger.log("info", "runtime.output.read", {
              name: output.name,
              selector: output.selector,
            });
            outputs[output.name] = transformOutputText(
              await session.readText(output.selector),
              output.transform,
            );
          }
        }

        if (process.writesToPlatform) {
          const screenshotPath = await session.screenshot(
            `visual-review-${process.name}`,
          );
          visualReview = await createPendingVisualReview({
            domain: input.domain,
            processName: process.name,
            taskId: input.taskId,
            screenshotPath,
            url: await session.currentUrl(),
            postconditions: process.postconditions,
            args: input.args,
          });
          this.logger.log("info", "runtime.visual_review.created", {
            processName: process.name,
            visualReviewId: visualReview.id,
            screenshotPath,
          });
        }
      }
    } finally {
      this.logger.log(
        input.taskId ? "debug" : "info",
        input.taskId ? "browser.detach" : "browser.close",
        {
          domain: input.domain,
          taskId: input.taskId,
        },
      );
      await session.close();
    }

    this.logger.log("info", "runtime.done", {
      processName: input.processName,
      executedStepCount: executedStepIds.length,
      driftedStepCount: driftedStepIds.length,
      outputCount: Object.keys(outputs).length,
      actionFailureCount: actionFailures.length,
      postconditionsPassed: postconditions.passed,
    });
    const drift: DriftReport = {
      detected: driftSteps.length > 0,
      severity: driftSteps.length > 0 ? "warning" : "none",
      steps: driftSteps,
    };
    const success = actionFailures.length === 0 && postconditions.passed;
    const failure =
      actionFailures.length > 0
        ? {
            kind: "action_failed" as const,
            reason: actionFailures[0].message,
          }
        : !postconditions.passed
          ? {
              kind: "postcondition_failed" as const,
              reason: postconditions.checks
                .filter((check) => !check.passed)
                .map(
                  (check) =>
                    `${check.type} expected ${check.expected}, observed ${check.observed || "unknown"}`,
                )
                .join("; "),
            }
          : undefined;
    return {
      success,
      processName: input.processName,
      executedStepIds,
      driftedStepIds,
      outputs,
      execution: {
        completed: actionFailures.length === 0,
        stepCount: process.steps.length,
        executedStepCount: executedStepIds.length,
        actionFailures,
      },
      preconditions,
      postconditions,
      drift,
      visualReview,
      failure,
      message: success
        ? drift.detected
          ? `Replayed ${executedStepIds.length} step(s); postconditions passed with drift warning.`
          : `Replayed ${executedStepIds.length} step(s); postconditions passed.`
        : failure?.reason || "Replay failed.",
    };
  }
}

function isUninitializedBrowserUrl(url: string): boolean {
  return url === "about:blank" || url === "";
}

function transformOutputText(
  text: string,
  transform: ProcessTape["outputs"][number]["transform"] | undefined,
): string {
  if (!transform || transform.type === "raw_text") return text;
  if (transform.type === "notification_rows") {
    return notificationRows(text, transform.limit || 20).join("\n");
  }
  const includePatterns = (transform.includePatterns || []).map(
    (pattern) => new RegExp(pattern, "i"),
  );
  const excludePatterns = (transform.excludePatterns || []).map(
    (pattern) => new RegExp(pattern, "i"),
  );
  const seen = new Set<string>();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) =>
      includePatterns.length
        ? includePatterns.some((pattern) => pattern.test(line))
        : true,
    )
    .filter((line) => !excludePatterns.some((pattern) => pattern.test(line)))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return lines.slice(0, transform.limit || lines.length).join("\n");
}

function notificationRows(text: string, limit: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isNotificationChromeLine(line));
  const rows: string[] = [];
  for (let index = 0; index < lines.length && rows.length < limit; index += 1) {
    const line = lines[index];
    if (isNotificationActivityLine(line)) {
      const actor = /^Reminder:/i.test(line)
        ? ""
        : nearestNotificationActor(lines, index);
      rows.push(actor ? `${actor} ${line}` : line);
    }
  }
  return [...new Set(rows)];
}

function nearestNotificationActor(
  lines: string[],
  activityIndex: number,
): string {
  for (
    let index = activityIndex - 1;
    index >= Math.max(0, activityIndex - 4);
    index -= 1
  ) {
    const candidate = lines[index];
    if (!candidate || isNotificationChromeLine(candidate)) continue;
    if (isNotificationActivityLine(candidate)) continue;
    if (/^(Following|Follow|Follow Back|Requested|Message)$/i.test(candidate))
      continue;
    return candidate;
  }
  return "";
}

function isNotificationActivityLine(line: string): boolean {
  return /started following you|liked your comment|liked your post|mentioned you|requested to follow|followed you|commented|shared a post|tagged you|accepted your follow request|review instagram/i.test(
    line,
  );
}

function isNotificationChromeLine(line: string): boolean {
  return /^(Notifications|All|People you follow|Comments|Follows|Tags and mentions|Verified|This week|This month|Earlier|Home|Search|Explore|Reels|Messages|Create|Profile|More)$/i.test(
    line,
  );
}

export class DefaultReplayValidator implements ReplayValidator {
  async validate(
    session: BrowserSession,
    validators?: StepValidator[],
  ): Promise<ValidationResult> {
    if (!validators?.length) return { passed: true, failures: [], checks: [] };
    const failures: string[] = [];
    const checks: ValidationCheck[] = [];
    for (const validator of validators) {
      if (validator.type === "url_equals") {
        const currentUrl = await session.currentUrl();
        const passed = currentUrl === validator.value;
        checks.push({
          type: validator.type,
          passed,
          expected: validator.value,
          observed: currentUrl,
        });
        if (!passed) {
          failures.push(
            `url_equals expected ${validator.value}, observed ${currentUrl}`,
          );
        }
      } else if (validator.type === "url_contains") {
        const currentUrl = await session.currentUrl();
        const passed = currentUrl.includes(validator.value);
        checks.push({
          type: validator.type,
          passed,
          expected: validator.value,
          observed: currentUrl,
        });
        if (!passed) {
          failures.push(
            `url_contains expected ${validator.value}, observed ${currentUrl}`,
          );
        }
      } else if (validator.type === "text_contains") {
        let text = "";
        try {
          text = await session.readText(validator.selector);
        } catch (error) {
          text = error instanceof Error ? error.message : String(error);
        }
        const passed = text.includes(validator.value);
        checks.push({
          type: validator.type,
          passed,
          expected: validator.value,
          observed: text.slice(0, 500),
          selector: validator.selector,
        });
        if (!passed) {
          failures.push(
            `text_contains missing ${validator.value} at ${validator.selector}`,
          );
        }
      } else if (validator.type === "scoped_text_contains") {
        const observations: string[] = [];
        let passed = false;
        for (const selector of validator.selectors) {
          let text = "";
          try {
            text = await session.readText(selector);
          } catch (error) {
            text = error instanceof Error ? error.message : String(error);
          }
          observations.push(`${selector}: ${text.slice(0, 240)}`);
          if (text.includes(validator.value)) passed = true;
        }
        checks.push({
          type: validator.type,
          passed,
          expected: validator.value,
          observed: observations.join("\n").slice(0, 500),
          selector: validator.selectors.join(", "),
        });
        if (!passed) {
          failures.push(
            `scoped_text_contains missing ${validator.value} at ${validator.selectors.join(", ")}`,
          );
        }
      } else if (validator.type === "rendered_text_contains") {
        let text = "";
        try {
          text = await session.readTextExcluding(
            validator.selector,
            validator.excludeSelectors || [
              "[contenteditable='true']",
              "textarea",
              "input",
              "[role='textbox']",
            ],
          );
        } catch (error) {
          text = error instanceof Error ? error.message : String(error);
        }
        const passed = text.includes(validator.value);
        checks.push({
          type: validator.type,
          passed,
          expected: validator.value,
          observed: text.slice(0, 500),
          selector: validator.selector,
        });
        if (!passed) {
          failures.push(
            `rendered_text_contains missing ${validator.value} at ${validator.selector}`,
          );
        }
      } else if (validator.type === "selector_exists") {
        const exists = await session.exists(validator.selector);
        checks.push({
          type: validator.type,
          passed: exists,
          expected: "selector exists",
          observed: exists ? "present" : "missing",
          selector: validator.selector,
        });
        if (!exists)
          failures.push(`selector_exists missing ${validator.selector}`);
      }
    }
    return { passed: failures.length === 0, failures, checks };
  }
}

function shouldSuppressFingerprintDrift(
  step: ProcessTape["steps"][number],
  validationPassed: boolean,
): boolean {
  return Boolean(
    validationPassed &&
      step.type === "navigate" &&
      step.validators?.length &&
      step.actions.every(
        (action) =>
          action.method === "goto" &&
          (action.selector.includes("%") ||
            action.arguments?.some((arg) => arg.includes("%"))),
      ),
  );
}

function failureResult(
  processName: string,
  stepCount: number,
  failure: RunFailure,
): RunProcessResult {
  return {
    success: false,
    processName,
    executedStepIds: [],
    driftedStepIds: [],
    outputs: {},
    execution: {
      completed: false,
      stepCount,
      executedStepCount: 0,
      actionFailures: [],
    },
    preconditions: {
      required: false,
      passed: false,
      checks: [],
    },
    postconditions: {
      required: false,
      passed: false,
      checks: [],
    },
    drift: {
      detected: false,
      severity: "none",
      steps: [],
    },
    failure,
    message: failure.reason,
  };
}

function findMissingRequiredArgs(
  process: ProcessTape,
  args?: RuntimeArgs,
): string[] {
  return process.args
    .filter((arg) => arg.required)
    .filter((arg) => {
      const value = args?.[arg.name];
      return (
        value === undefined ||
        value === null ||
        value === true ||
        String(value).trim() === ""
      );
    })
    .map((arg) => arg.name);
}

function bindActionArgs(action: Action, args?: RuntimeArgs): Action {
  if (!args) return action;
  const replacements = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [`%${key}%`, String(value)]),
  );
  return {
    ...action,
    selector: replacePlaceholders(action.selector, replacements),
    arguments: (action.arguments || []).map((arg) =>
      replacePlaceholders(arg, replacements),
    ),
  };
}

function actionHasRuntimePlaceholder(action: Action): boolean {
  return (
    /%[a-zA-Z][a-zA-Z0-9_]*%/.test(action.selector) ||
    (action.arguments || []).some((arg) => /%[a-zA-Z][a-zA-Z0-9_]*%/.test(arg))
  );
}

async function executeActionWithSelectorFallbacks(input: {
  session: BrowserSession;
  action: Action;
  stepType: ProcessTape["steps"][number]["type"];
  alternatives?: StepSelectorDiagnostics["alternatives"];
  siteConfig: SiteConfig;
  logger: CartographerLogger;
}): Promise<{
  success: boolean;
  message: string;
  selector?: string;
  diagnosticScreenshotPath?: string;
}> {
  const candidates = [
    input.action.selector,
    ...(input.alternatives || []).map((candidate) => candidate.selector),
  ].filter(
    (selector, index, selectors) =>
      selector && selectors.indexOf(selector) === index,
  );

  const interrupts = input.siteConfig.knownInterrupts;

  let lastMessage = "No selector candidates were available.";

  async function tryAction() {
    for (const selector of candidates) {
      const action = { ...input.action, selector };
      try {
        if (input.stepType === "navigate") {
          await withTimeout(
            input.session.goto(action.selector),
            REPLAY_ACTION_TIMEOUT_MS,
            `Timed out navigating to ${action.selector}`,
          );
          return { success: true, message: "navigation succeeded", selector };
        }
        // Phase 4: Explicit scrolling and visibility guarantees
        if (requiresVisibleEnabledElement(action.method)) {
          await withTimeout(
            input.session.scrollIntoView(selector),
            REPLAY_ACTION_TIMEOUT_MS,
            `Timed out scrolling ${selector} into view`,
          );
          const isVisible = await withTimeout(
            input.session.isVisible(selector),
            REPLAY_ACTION_TIMEOUT_MS,
            `Timed out checking visibility for ${selector}`,
          );
          if (!isVisible) {
            lastMessage = `Element obscured or not visible: ${selector}`;
            continue;
          }
          const isEnabled = await withTimeout(
            input.session.isEnabled(selector),
            REPLAY_ACTION_TIMEOUT_MS,
            `Timed out checking enabled state for ${selector}`,
          );
          if (!isEnabled) {
            lastMessage = `Element is disabled: ${selector}`;
            continue;
          }
        }

        const outcome = await withTimeout(
          input.session.actRaw(action),
          REPLAY_ACTION_TIMEOUT_MS,
          `Timed out running ${action.method || "action"} on ${selector}`,
        );
        if (outcome.success) {
          if (selector !== input.action.selector) {
            input.logger.log("info", "runtime.action.selector_fallback_hit", {
              primarySelector: input.action.selector,
              selector,
            });
          }
          return { ...outcome, selector };
        }
        lastMessage = outcome.message;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
      }
    }
    return null;
  }

  // First attempt
  const result = await tryAction();
  if (result) return result;

  // Phase 2: Intermittent Modal / Popup Handling
  input.logger.log("info", "runtime.interrupt_check", {
    message: lastMessage,
    interruptCount: interrupts.length,
  });

  for (const interrupt of interrupts) {
    if (await input.session.isVisible(interrupt.dismissSelector)) {
      input.logger.log("info", "runtime.interrupt_hit", {
        name: interrupt.name,
        dismissSelector: interrupt.dismissSelector,
      });
      try {
        await withTimeout(
          input.session.actRaw({
            method: "click",
            selector: interrupt.dismissSelector,
            description: `Dismiss interrupt: ${interrupt.name}`,
          }),
          REPLAY_ACTION_TIMEOUT_MS,
          `Timed out dismissing interrupt ${interrupt.name}`,
        );
        await withTimeout(
          input.session.waitForSettle(),
          REPLAY_ACTION_TIMEOUT_MS,
          `Timed out settling after interrupt ${interrupt.name}`,
        );
      } catch (error) {
        input.logger.log("warn", "runtime.interrupt_dismiss_failed", {
          name: interrupt.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Retry original action after dismissing interrupt
      const retryResult = await tryAction();
      if (retryResult) return retryResult;
    }
  }

  let diagnosticScreenshotPath: string | undefined;
  if (!result) {
    diagnosticScreenshotPath = await input.session
      .screenshot("replay-failure-diagnostic")
      .catch((e: unknown): undefined => {
        input.logger.log("warn", "runtime.screenshot_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      });
  }

  return (
    result || {
      success: false,
      message: lastMessage,
      selector: candidates[candidates.length - 1] || input.action.selector,
      diagnosticScreenshotPath,
    }
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function requiresVisibleEnabledElement(method?: string): boolean {
  return [
    "click",
    "dblclick",
    "hover",
    "fill",
    "type",
    "press",
    "check",
    "uncheck",
    "select",
    "upload",
  ].includes(method || "");
}

function bindValidators(
  validators?: StepValidator[],
  args?: RuntimeArgs,
): StepValidator[] | undefined {
  if (!validators?.length || !args) return validators;
  const replacements = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [`%${key}%`, String(value)]),
  );
  return validators.map((validator) => {
    if (validator.type === "selector_exists") {
      return {
        ...validator,
        selector: replacePlaceholders(validator.selector, replacements),
      };
    }
    if (validator.type === "scoped_text_contains") {
      return {
        ...validator,
        selectors: validator.selectors.map((selector) =>
          replacePlaceholders(selector, replacements),
        ),
        value: replacePlaceholders(validator.value, replacements),
      };
    }
    return {
      ...validator,
      value: replacePlaceholders(validator.value, replacements),
    };
  });
}

function replacePlaceholders(
  value: string,
  replacements: Record<string, string>,
): string {
  let result = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

function comparableFingerprint(state: State): StateFingerprint {
  const atomIds = [...state.fingerprint.atomIds].sort();
  const urlShape = shapeUrl(state.fingerprint.urlShape || state.url);
  return {
    ...state.fingerprint,
    hash: sha256({ atomIds, kind: state.kind, urlShape }),
    atomIds,
    urlShape,
    atomCount: atomIds.length,
  };
}
