import type { Domain, TaskId, TaskSegmentId } from "./contracts.js";
import { slugifyName } from "./paths.js";
import { sha256 } from "./hash.js";

export const PLAYWRIGHT_CLI_BASE_COMMANDS = [
  "open",
  "attach",
  "goto",
  "snapshot",
  "click",
  "dblclick",
  "fill",
  "drag",
  "type",
  "press",
  "keydown",
  "keyup",
  "hover",
  "select",
  "upload",
  "check",
  "uncheck",
  "eval",
  "dialog-accept",
  "dialog-dismiss",
  "resize",
  "screenshot",
  "pdf",
  "go-back",
  "go-forward",
  "reload",
  "mousemove",
  "mousedown",
  "mouseup",
  "mousewheel",
  "list",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "state-save",
  "state-load",
  "cookie-list",
  "cookie-get",
  "cookie-set",
  "cookie-delete",
  "cookie-clear",
  "localstorage-list",
  "localstorage-get",
  "localstorage-set",
  "localstorage-delete",
  "localstorage-clear",
  "sessionstorage-list",
  "sessionstorage-get",
  "sessionstorage-set",
  "sessionstorage-delete",
  "sessionstorage-clear",
  "route",
  "route-list",
  "unroute",
  "network-state-set",
  "console",
  "network",
  "run-code",
  "tracing-start",
  "tracing-stop",
  "video-start",
  "video-stop",
  "video-chapter",
  "show",
  "pause-at",
  "resume",
  "step-over",
  "close",
  "delete-data",
] as const;

export type PlaywrightCliBaseCommand =
  (typeof PLAYWRIGHT_CLI_BASE_COMMANDS)[number];

export type CartographerCliCommandSurface =
  | "base_browser_command"
  | "acquired_site_command";

export interface PlaywrightCliSessionRef {
  domain: Domain;
  sessionName: string;
  taskId?: TaskId;
  profile?: string;
  persistent: boolean;
}

export interface PlaywrightCliCommandRequest {
  session: PlaywrightCliSessionRef;
  command: PlaywrightCliBaseCommand;
  args: string[];
  taskSegmentId?: TaskSegmentId;
  cwd?: string;
  raw?: boolean;
  json?: boolean;
}

export interface PlaywrightCliPageState {
  url?: string;
  title?: string;
  snapshotPath?: string;
  snapshotText?: string;
}

export interface PlaywrightCliGeneratedLocator {
  target: string;
  locator: string;
}

export interface PlaywrightCliCommandResult {
  success: boolean;
  surface: "base_browser_command";
  command: PlaywrightCliBaseCommand;
  args: string[];
  page?: PlaywrightCliPageState;
  generatedCode?: string[];
  generatedLocator?: PlaywrightCliGeneratedLocator;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface PlaywrightCliSubstrate {
  openSession(session: PlaywrightCliSessionRef): Promise<void>;
  runBaseCommand(
    request: PlaywrightCliCommandRequest,
  ): Promise<PlaywrightCliCommandResult>;
  closeSession(session: PlaywrightCliSessionRef): Promise<void>;
}

export interface PlaywrightCliRecordingSink {
  recordBaseCommand(
    request: PlaywrightCliCommandRequest,
    result: PlaywrightCliCommandResult,
  ): Promise<void>;
}

export function cartographerPlaywrightCliSessionName(input: {
  domain: Domain;
  taskId?: TaskId;
  profile?: string;
}): string {
  const profile = input.profile || "default";
  const suffix = input.taskId || profile;
  return `c${sha256({ domain: input.domain, suffix }).slice(0, 6)}`;
}
