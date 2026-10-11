import type { FallbackOperationKind } from "./contracts.js";
import {
  PLAYWRIGHT_CLI_BASE_COMMANDS,
  type PlaywrightCliBaseCommand,
} from "./playwright-cli-substrate.js";

export interface PlaywrightCliCommandSpec {
  command: PlaywrightCliBaseCommand;
  minArgs?: number;
  maxArgs?: number;
  selectorArgIndex?: number;
  kind: FallbackOperationKind;
  writesToPlatform: boolean | "heuristic";
  promotionEligible: boolean;
}

const READ_COMMANDS = new Set<PlaywrightCliBaseCommand>([
  "open",
  "goto",
  "snapshot",
  "screenshot",
  "pdf",
  "console",
  "network",
  "route-list",
  "list",
  "tab-list",
  "cookie-list",
  "cookie-get",
  "localstorage-list",
  "localstorage-get",
  "sessionstorage-list",
  "sessionstorage-get",
  "eval",
]);

const HEURISTIC_WRITE_COMMANDS = new Set<PlaywrightCliBaseCommand>([
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
]);

const PROMOTION_ELIGIBLE = new Set<PlaywrightCliBaseCommand>([
  "goto",
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
]);

const SELECTOR_ARG_INDEX: Partial<Record<PlaywrightCliBaseCommand, number>> = {
  click: 0,
  dblclick: 0,
  hover: 0,
  fill: 0,
  drag: 0,
  check: 0,
  uncheck: 0,
  select: 0,
  upload: 0,
  snapshot: 0,
};

const MIN_ARGS: Partial<Record<PlaywrightCliBaseCommand, number>> = {
  goto: 1,
  click: 1,
  dblclick: 1,
  hover: 1,
  fill: 2,
  drag: 1,
  type: 1,
  press: 1,
  keydown: 1,
  keyup: 1,
  select: 2,
  upload: 2,
  check: 1,
  uncheck: 1,
  eval: 1,
};

const MAX_ARGS: Partial<Record<PlaywrightCliBaseCommand, number>> = {
  press: 1,
  keydown: 1,
  keyup: 1,
};

export function playwrightCliCommandSpec(
  command: PlaywrightCliBaseCommand,
): PlaywrightCliCommandSpec {
  return {
    command,
    minArgs: MIN_ARGS[command],
    maxArgs: MAX_ARGS[command],
    selectorArgIndex: SELECTOR_ARG_INDEX[command],
    kind: operationKind(command),
    writesToPlatform: HEURISTIC_WRITE_COMMANDS.has(command)
      ? "heuristic"
      : !READ_COMMANDS.has(command),
    promotionEligible: PROMOTION_ELIGIBLE.has(command),
  };
}

export function normalizePlaywrightCliCommand(
  command: string,
): PlaywrightCliBaseCommand {
  if (!command) throw new Error("Missing Playwright CLI command.");
  if (!isPlaywrightCliCommand(command)) {
    throw new Error(
      `Unsupported Playwright CLI command for recorded fallback: ${command}. Supported commands: ${PLAYWRIGHT_CLI_BASE_COMMANDS.join(", ")}`,
    );
  }
  return command;
}

export function isPlaywrightCliCommand(
  value: string,
): value is PlaywrightCliBaseCommand {
  return (PLAYWRIGHT_CLI_BASE_COMMANDS as readonly string[]).includes(value);
}

export function normalizePlaywrightCliArgs(input: {
  command: PlaywrightCliBaseCommand;
  args: string[];
}): string[] {
  const spec = playwrightCliCommandSpec(input.command);
  if (
    spec.maxArgs !== undefined &&
    input.args.length > spec.maxArgs &&
    input.command === "press"
  ) {
    throw new Error(
      "Playwright CLI `press` accepts one key argument, for example `press Enter`. In Cartographer shell and `cg pw`, `press <selector> <key>` expands to recorded click+press.",
    );
  }
  if (spec.minArgs !== undefined && input.args.length < spec.minArgs) {
    throw new Error(
      `Playwright CLI \`${input.command}\` requires at least ${spec.minArgs} argument(s).`,
    );
  }
  if (spec.maxArgs !== undefined && input.args.length > spec.maxArgs) {
    throw new Error(
      `Playwright CLI \`${input.command}\` accepts at most ${spec.maxArgs} argument(s).`,
    );
  }
  return input.args;
}

export function selectorArgForCommand(input: {
  command: PlaywrightCliBaseCommand;
  args: string[];
}): string | undefined {
  const index = playwrightCliCommandSpec(input.command).selectorArgIndex;
  return index === undefined ? undefined : input.args[index];
}

function operationKind(
  command: PlaywrightCliBaseCommand,
): FallbackOperationKind {
  if (command === "run-code") return "run_code";
  if (
    command === "open" ||
    command === "goto" ||
    command === "snapshot" ||
    command === "click" ||
    command === "dblclick" ||
    command === "hover" ||
    command === "fill" ||
    command === "type" ||
    command === "press" ||
    command === "check" ||
    command === "uncheck" ||
    command === "select" ||
    command === "upload" ||
    command === "eval" ||
    command === "screenshot"
  ) {
    return command;
  }
  return "cli";
}
