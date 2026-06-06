import { spawn } from "node:child_process";
import path from "node:path";
import type {
  Domain,
  FallbackOperation,
  TaskId,
  TaskSegmentId,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { appendSegmentOperation } from "./segment-journal.js";
import { cartographerPlaywrightCliSessionName } from "./playwright-cli-substrate.js";
import type { PlaywrightCliBaseCommand } from "./playwright-cli-substrate.js";
import { connectOrStartTaskBrowser } from "./task-browser.js";
import { writePlaywrightCliEvidence } from "./playwright-cli-evidence.js";
import { probeWriteGrounding } from "./write-grounding.js";
import {
  isPlaywrightCliCommand,
  normalizePlaywrightCliArgs,
  normalizePlaywrightCliCommand,
  playwrightCliCommandSpec,
  selectorArgForCommand,
} from "./playwright-cli-command-spec.js";

export interface RunRecordedPlaywrightCliInput {
  domain: Domain;
  taskId: TaskId;
  segmentId: TaskSegmentId;
  command: string;
  args: string[];
  intent: string;
  json?: boolean;
}

export interface RunRecordedPlaywrightCliResult {
  success: boolean;
  sessionName: string;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  operation: FallbackOperation;
}

export async function runRecordedPlaywrightCli(
  input: RunRecordedPlaywrightCliInput,
): Promise<RunRecordedPlaywrightCliResult> {
  const session = await RecordedPlaywrightCliSession.open({
    domain: input.domain,
    taskId: input.taskId,
  });
  try {
    return await session.run(input);
  } finally {
    session.close();
  }
}

export class RecordedPlaywrightCliSession {
  private attached = false;

  private constructor(
    private readonly connection: Awaited<
      ReturnType<typeof connectOrStartTaskBrowser>
    >,
    private readonly input: {
      domain: Domain;
      taskId: TaskId;
      sessionName: string;
    },
  ) {}

  static async open(input: {
    domain: Domain;
    taskId: TaskId;
  }): Promise<RecordedPlaywrightCliSession> {
    const connection = await connectOrStartTaskBrowser(
      input.domain,
      input.taskId,
    );
    return new RecordedPlaywrightCliSession(connection, {
      ...input,
      sessionName: cartographerPlaywrightCliSessionName({
        domain: input.domain,
        taskId: input.taskId,
      }),
    });
  }

  async run(
    input: RunRecordedPlaywrightCliInput,
  ): Promise<RunRecordedPlaywrightCliResult> {
    if (
      input.domain !== this.input.domain ||
      input.taskId !== this.input.taskId
    ) {
      throw new Error("Recorded Playwright CLI session task/domain mismatch.");
    }
    await this.attachOnce();
    return await runRecordedPlaywrightCliInSession({
      ...input,
      sessionName: this.input.sessionName,
      taskBrowser: this.connection,
    });
  }

  close(): void {
    disconnectTaskBrowserClient(this.connection.browser);
  }

  private async attachOnce(): Promise<void> {
    if (this.attached) return;
    const attach = await runPlaywrightCli([
      `-s=${this.input.sessionName}`,
      "attach",
      "--cdp",
      this.connection.cdpUrl,
    ]);
    if (attach.exitCode !== 0) {
      throw new Error(
        attach.stderr.trim() ||
          attach.stdout.trim() ||
          "playwright-cli attach failed",
      );
    }
    this.attached = true;
  }
}

async function runRecordedPlaywrightCliInSession(
  input: RunRecordedPlaywrightCliInput & {
    sessionName: string;
    taskBrowser: Awaited<ReturnType<typeof connectOrStartTaskBrowser>>;
  },
): Promise<RunRecordedPlaywrightCliResult> {
  const command = normalizePlaywrightCliCommand(input.command);
  const commandArgs = normalizePlaywrightCliArgs({
    command,
    args: input.args,
  });
  const spec = playwrightCliCommandSpec(command);

  const startedAt = new Date().toISOString();
  const urlBefore = await currentPageUrl(input.taskBrowser.page);
  const commandArgsForExecution = selectorCompatibleArgs(command, commandArgs);
  const preGrounding = await probeWriteGrounding({
    page: input.taskBrowser.page,
    command,
    args: commandArgsForExecution,
    targetSelector: selectorForCommand(command, commandArgsForExecution),
    selectorCandidates: [],
    urlBefore,
  });
  const result = await runPlaywrightCli([
    `-s=${input.sessionName}`,
    command,
    ...commandArgsForExecution,
  ]);
  const normalizedResult = normalizePlaywrightCliResult(result);
  const operationId = sha256({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: input.segmentId,
    command,
    args: commandArgsForExecution,
    startedAt,
  });
  const evidence = await writePlaywrightCliEvidence({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: input.segmentId,
    operationId,
    command,
    args: commandArgsForExecution,
    stdout: normalizedResult.stdout,
    stderr: normalizedResult.stderr,
    exitCode: normalizedResult.exitCode,
    startedAt,
    urlBefore,
    page: input.taskBrowser.page,
    preWriteGrounding: preGrounding.summary,
    preActionDiscovery: preGrounding.actionDiscovery,
  });
  const operation: FallbackOperation = {
    id: operationId,
    kind: spec.kind,
    surface: "fallback",
    promotionEligible: spec.promotionEligible,
    instruction: ["playwright-cli", command, ...input.args].join(" "),
    command,
    commandArgs: commandArgsForExecution,
    success: normalizedResult.exitCode === 0,
    failureReason:
      normalizedResult.exitCode === 0
        ? undefined
        : normalizedResult.stderr.trim() ||
          normalizedResult.stdout.trim() ||
          "playwright-cli failed",
    writesToPlatform: writesToPlatform({
      command,
      args: commandArgsForExecution,
      urlBefore,
      urlAfter: evidence.urlAfter || extractPageUrl(normalizedResult.stdout),
    }),
    urlBefore,
    urlAfter: evidence.urlAfter || extractPageUrl(normalizedResult.stdout),
    selector: evidence.selector || selectorForCommand(command, commandArgs),
    selectorKind: evidence.selectorKind,
    selectorCandidates: evidence.selectorCandidates,
    writeGrounding: evidence.writeGrounding,
    evidencePath:
      evidence.evidencePath || extractSnapshotPath(normalizedResult.stdout),
    evidencePaths: evidence.evidencePaths,
    evidenceSummaryPath: evidence.evidenceSummaryPath,
    evidenceSummary: evidence.evidenceSummary,
    createdAt: startedAt,
  };
  await appendSegmentOperation({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: input.segmentId,
    operation,
  });
  return {
    success: normalizedResult.exitCode === 0,
    sessionName: input.sessionName,
    command,
    args: commandArgsForExecution,
    stdout: normalizedResult.stdout,
    stderr: normalizedResult.stderr,
    operation,
  };
}

export { isPlaywrightCliCommand };

async function runPlaywrightCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const bin = process.env.CARTOGRAPHER_PLAYWRIGHT_CLI_BIN || "playwright-cli";
  const daemonDir =
    process.env.CARTOGRAPHER_PLAYWRIGHT_DAEMON_DIR ||
    path.join("/private/tmp", "cartographer-playwright-daemon");
  const timeoutMs = Number(
    process.env.CARTOGRAPHER_PLAYWRIGHT_CLI_TIMEOUT_MS || "45000",
  );
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PLAYWRIGHT_DAEMON_SESSION_DIR: daemonDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `\nplaywright-cli timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: timedOut ? 124 : code || 0, stdout, stderr });
    });
  });
}

function writesToPlatform(input: {
  command: PlaywrightCliBaseCommand;
  args: string[];
  urlBefore?: string;
  urlAfter?: string;
}): boolean {
  const spec = playwrightCliCommandSpec(input.command);
  if (spec.writesToPlatform !== "heuristic") return spec.writesToPlatform;
  const source = writeKeywordSource(input);
  const hasWriteKeyword =
    /\b(send|submit|post|publish|save|confirm|delete|remove|follow|unfollow|like|unlike)\b/.test(
      source,
    );
  if (hasWriteKeyword) return true;
  if (input.command === "press") {
    return (input.args[0] || "").toLowerCase() === "enter";
  }
  if (input.command === "fill" || input.command === "type") {
    return source.includes("/direct/t/");
  }
  return false;
}

function writeKeywordSource(input: {
  command: string;
  args: string[];
  urlBefore?: string;
  urlAfter?: string;
}): string {
  return `${input.command} ${input.args.join(" ")} ${input.urlBefore || ""} ${input.urlAfter || ""}`.toLowerCase();
}

function extractPageUrl(stdout: string): string | undefined {
  return stdout.match(/Page URL:\s*(.+)/)?.[1]?.trim();
}

function extractSnapshotPath(stdout: string): string | undefined {
  return stdout.match(/\[Snapshot\]\(([^)]+)\)/)?.[1]?.trim();
}

function disconnectTaskBrowserClient(browser: unknown): void {
  (browser as { disconnect?: () => void } | undefined)?.disconnect?.();
}

async function currentPageUrl(page: { url(): string }): Promise<string> {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function selectorForCommand(
  command: PlaywrightCliBaseCommand,
  args: string[],
): string | undefined {
  if (command === "goto" || command === "open") return args[0];
  return selectorArgForCommand({ command, args });
}

function selectorCompatibleArgs(
  command: PlaywrightCliBaseCommand,
  args: string[],
): string[] {
  const selectorArg = selectorArgForCommand({ command, args });
  if (!selectorArg) return args;
  const index = playwrightCliCommandSpec(command).selectorArgIndex;
  if (index === undefined) return args;
  const compatible = selectorForPlaywrightCli(command, selectorArg);
  if (compatible === selectorArg) return args;
  const next = [...args];
  next[index] = compatible;
  return next;
}

function selectorForPlaywrightCli(
  command: PlaywrightCliBaseCommand,
  selector: string,
): string {
  const placeholder = selector.match(/^placeholder=(.+)$/)?.[1];
  if (placeholder && command === "fill") {
    return `role=textbox[name=${placeholder}]`;
  }
  const label = selector.match(/^label=(.+)$/)?.[1];
  if (label && command === "fill") {
    return `role=textbox[name=${label}]`;
  }
  return selector;
}

function normalizePlaywrightCliResult(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  if (result.exitCode !== 0) return result;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/### Error\b|^Error:|Unknown engine|TimeoutError:/m.test(output)) {
    return {
      ...result,
      exitCode: 1,
      stderr: result.stderr.trim()
        ? result.stderr
        : firstErrorBlock(result.stdout) || "playwright-cli reported an error",
    };
  }
  return result;
}

function firstErrorBlock(stdout: string): string {
  const match = stdout.match(/### Error\s*([\s\S]*)/);
  return match?.[1]?.trim() || "";
}
