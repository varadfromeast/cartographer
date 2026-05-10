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
  const result = await runPlaywrightCli([
    `-s=${input.sessionName}`,
    command,
    ...commandArgs,
  ]);
  const operationId = sha256({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: input.segmentId,
    command,
    args: commandArgs,
    startedAt,
  });
  const evidence = await writePlaywrightCliEvidence({
    domain: input.domain,
    taskId: input.taskId,
    segmentId: input.segmentId,
    operationId,
    command,
    args: commandArgs,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    startedAt,
    urlBefore,
  });
  const operation: FallbackOperation = {
    id: operationId,
    kind: spec.kind,
    surface: "fallback",
    promotionEligible: spec.promotionEligible,
    instruction: ["playwright-cli", command, ...input.args].join(" "),
    command,
    commandArgs,
    success: result.exitCode === 0,
    failureReason:
      result.exitCode === 0
        ? undefined
        : result.stderr.trim() ||
          result.stdout.trim() ||
          "playwright-cli failed",
    writesToPlatform: writesToPlatform({
      command,
      args: input.args,
      urlBefore,
      urlAfter: evidence.urlAfter || extractPageUrl(result.stdout),
    }),
    urlBefore,
    urlAfter: evidence.urlAfter || extractPageUrl(result.stdout),
    selector: evidence.selector || selectorForCommand(command, commandArgs),
    selectorKind: evidence.selectorKind,
    selectorCandidates: evidence.selectorCandidates,
    evidencePath: evidence.evidencePath || extractSnapshotPath(result.stdout),
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
    success: result.exitCode === 0,
    sessionName: input.sessionName,
    command,
    args: commandArgs,
    stdout: result.stdout,
    stderr: result.stderr,
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
    process.env.CARTOGRAPHER_PLAYWRIGHT_CLI_TIMEOUT_MS || "15000",
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        exitCode: 124,
        stdout,
        stderr:
          `${stderr}\nplaywright-cli timed out after ${timeoutMs}ms: ${args.join(" ")}`.trim(),
      });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code || 0, stdout, stderr });
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
  if (
    (input.command === "click" ||
      input.command === "dblclick" ||
      input.command === "press") &&
    input.urlBefore &&
    input.urlAfter &&
    input.urlBefore !== input.urlAfter &&
    !writeKeywordSource(input).match(
      /\b(send|submit|post|publish|save|confirm|delete|remove)\b/,
    )
  ) {
    return false;
  }
  return true;
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
