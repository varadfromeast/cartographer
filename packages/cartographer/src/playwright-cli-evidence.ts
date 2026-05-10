import fs from "node:fs/promises";
import path from "node:path";
import type {
  Domain,
  FallbackOperation,
  PlaywrightCliEvidenceSummary,
  SelectorDiagnosticCandidate,
  SnapshotControlSummary,
  TaskId,
  TaskSegmentId,
} from "./contracts.js";
import { ensureDir, writeJsonFile } from "./fs-json.js";
import { classifySelector } from "./playwright-selector.js";
import { taskSegmentEvidenceDir } from "./paths.js";

export interface PlaywrightCliEvidenceInput {
  domain: Domain;
  taskId: TaskId;
  segmentId: TaskSegmentId;
  operationId: string;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  urlBefore?: string;
}

export interface PlaywrightCliEvidenceResult {
  evidencePath?: string;
  evidencePaths: Record<string, string>;
  selector?: string;
  selectorKind?: FallbackOperation["selectorKind"];
  selectorCandidates?: SelectorDiagnosticCandidate[];
  evidenceSummaryPath?: string;
  evidenceSummary?: PlaywrightCliEvidenceSummary;
  urlAfter?: string;
}

export interface SnapshotRefEvidence {
  ref: string;
  role: string;
  name?: string;
  href?: string;
}

export async function writePlaywrightCliEvidence(
  input: PlaywrightCliEvidenceInput,
): Promise<PlaywrightCliEvidenceResult> {
  const dir = path.join(
    taskSegmentEvidenceDir(input.domain, input.taskId, input.segmentId),
    operationEvidenceDirName(input.command, input.operationId),
  );
  await ensureDir(dir);

  const stdoutPath = path.join(dir, "stdout.txt");
  const stderrPath = path.join(dir, "stderr.txt");
  await fs.writeFile(stdoutPath, input.stdout, "utf8");
  const evidencePaths: Record<string, string> = { stdout: stdoutPath };
  if (input.stderr.trim()) {
    await fs.writeFile(stderrPath, input.stderr, "utf8");
    evidencePaths.stderr = stderrPath;
  }

  const page = {
    command: input.command,
    args: input.args,
    success: input.exitCode === 0,
    exitCode: input.exitCode,
    urlBefore: input.urlBefore,
    urlAfter: extractPageUrl(input.stdout),
    title: extractPageTitle(input.stdout),
    consoleSummary: extractConsoleSummary(input.stdout),
    createdAt: input.startedAt,
  };
  const pagePath = path.join(dir, "page.json");
  await writeJsonFile(pagePath, page);
  evidencePaths.page = pagePath;

  const snapshot = extractSnapshotYaml(input.stdout);
  const refs = snapshot ? extractRefs(snapshot) : [];
  if (snapshot) {
    const snapshotPath = path.join(dir, "snapshot.yaml");
    await fs.writeFile(snapshotPath, snapshot, "utf8");
    evidencePaths.snapshot = snapshotPath;
  }
  if (refs.length) {
    const refsPath = path.join(dir, "refs.json");
    await writeJsonFile(refsPath, refs);
    evidencePaths.refs = refsPath;
  }

  const targetSelector = selectorArg(input.command, input.args);
  const targetRef = targetSelector?.match(/^(?:aria-ref=)?([a-z]?\d+)$/i)?.[1];
  const target = targetRef
    ? refs.find((item) => item.ref.toLowerCase() === targetRef.toLowerCase())
    : undefined;
  const selectorCandidates = target
    ? selectorCandidatesForSnapshotRef(target)
    : selectorCandidatesForSelector(targetSelector);
  const summary = createEvidenceSummary({
    input,
    page,
    refs,
    targetSelector,
    target,
    selectorCandidates,
    snapshot,
  });
  const summaryPath = path.join(dir, "summary.json");
  await writeJsonFile(summaryPath, summary);
  evidencePaths.summary = summaryPath;
  if (targetSelector || target || selectorCandidates.length) {
    const targetPath = path.join(dir, "target.json");
    await writeJsonFile(targetPath, {
      selectorArg: targetSelector,
      targetRef,
      target,
      selectorCandidates,
    });
    evidencePaths.target = targetPath;
  }

  return {
    evidencePath: evidencePaths.snapshot || evidencePaths.stdout,
    evidencePaths,
    evidenceSummaryPath: summaryPath,
    evidenceSummary: summary,
    selector: bestSelector(targetSelector, selectorCandidates),
    selectorKind: classifySelector(
      bestSelector(targetSelector, selectorCandidates),
    ),
    selectorCandidates,
    urlAfter: page.urlAfter,
  };
}

function createEvidenceSummary(input: {
  input: PlaywrightCliEvidenceInput;
  page: {
    command: string;
    args: string[];
    success: boolean;
    exitCode: number;
    urlBefore?: string;
    urlAfter?: string;
    title?: string;
    consoleSummary?: string;
    createdAt: string;
  };
  refs: SnapshotRefEvidence[];
  targetSelector?: string;
  target?: SnapshotRefEvidence;
  selectorCandidates: SelectorDiagnosticCandidate[];
  snapshot?: string;
}): PlaywrightCliEvidenceSummary {
  const controls = topControls(input.refs);
  const warnings = evidenceWarnings(input);
  const preview = [
    input.page.urlAfter ? `url: ${input.page.urlAfter}` : undefined,
    input.page.title ? `title: ${input.page.title}` : undefined,
    input.target
      ? `target: ${compactControl(input.target)}`
      : input.targetSelector
        ? `target: ${input.targetSelector}`
        : undefined,
    controls.length
      ? `controls: ${controls.map(compactControl).join(" | ")}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  return {
    schemaVersion: 1,
    command: input.input.command,
    args: input.input.args,
    success: input.page.success,
    urlBefore: input.page.urlBefore,
    urlAfter: input.page.urlAfter,
    title: input.page.title,
    consoleSummary: input.page.consoleSummary,
    target:
      input.target || input.targetSelector
        ? {
            selectorArg: input.targetSelector,
            ref: input.target?.ref,
            role: input.target?.role,
            name: input.target?.name,
            href: input.target?.href,
          }
        : undefined,
    counts: {
      refs: input.refs.length,
      links: input.refs.filter((ref) => ref.role === "link").length,
      buttons: input.refs.filter((ref) => ref.role === "button").length,
      textboxes: input.refs.filter((ref) => ref.role === "textbox").length,
      snapshots: input.snapshot ? 1 : 0,
    },
    controls,
    selectorCandidates: input.selectorCandidates,
    warnings,
    preview,
    createdAt: input.input.startedAt,
  };
}

function topControls(refs: SnapshotRefEvidence[]): SnapshotControlSummary[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .filter(
      ({ ref }) =>
        isRoleLocatorRole(ref.role) &&
        (ref.name || ref.href) &&
        !isLikelyNoise(ref.name),
    )
    .sort((left, right) => {
      const priority =
        controlPriority(right.ref) - controlPriority(left.ref) ||
        left.index - right.index;
      return priority;
    })
    .slice(0, 20)
    .map(({ ref }) => ({
      ref: ref.ref,
      role: ref.role,
      name: ref.name,
      href: ref.href,
    }));
}

function controlPriority(ref: SnapshotRefEvidence): number {
  const text = `${ref.role} ${ref.name || ""} ${ref.href || ""}`.toLowerCase();
  let score = 0;
  if (ref.role === "textbox") score += 100;
  if (ref.role === "button") score += 50;
  if (/\b(message|send|search|next|done|confirm|submit)\b/.test(text)) {
    score += 40;
  }
  if (ref.href?.includes("/direct/")) score += 20;
  if (hasTransientText(text)) score -= 25;
  return score;
}

function evidenceWarnings(input: {
  input: PlaywrightCliEvidenceInput;
  targetSelector?: string;
  target?: SnapshotRefEvidence;
  selectorCandidates: SelectorDiagnosticCandidate[];
}): string[] {
  const warnings: string[] = [];
  if (input.targetSelector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i)) {
    warnings.push("raw_snapshot_ref_target");
  }
  if (
    input.targetSelector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i) &&
    !input.target
  ) {
    warnings.push("snapshot_ref_not_resolved");
  }
  if (
    input.input.command === "click" &&
    input.target?.name &&
    hasTransientText(input.target.name)
  ) {
    warnings.push("target_name_contains_transient_text");
  }
  if (
    input.input.command === "fill" &&
    !input.selectorCandidates.some(
      (candidate) => candidate.stability !== "weak",
    )
  ) {
    warnings.push("fill_target_has_no_durable_selector");
  }
  return [...new Set(warnings)];
}

function compactControl(control: SnapshotControlSummary | SnapshotRefEvidence) {
  const label = [control.role, control.name ? JSON.stringify(control.name) : ""]
    .filter(Boolean)
    .join(" ");
  const href = control.href ? ` -> ${control.href}` : "";
  return `${control.ref} ${label}${href}`.trim();
}

function isLikelyNoise(name?: string): boolean {
  if (!name) return false;
  return name.length > 120;
}

function hasTransientText(value: string): boolean {
  return /\b(\d+\s*(m|h|d|w|mo|yr|mins?|hours?|days?)\s+ago|liked a message|sent an attachment|active now)\b/i.test(
    value,
  );
}

function operationEvidenceDirName(
  command: string,
  operationId: string,
): string {
  return `${command.replace(/[^a-z0-9_-]+/gi, "-")}-${operationId.slice(0, 10)}`;
}

function extractPageUrl(stdout: string): string | undefined {
  return stdout.match(/Page URL:\s*(.+)/)?.[1]?.trim();
}

function extractPageTitle(stdout: string): string | undefined {
  return stdout.match(/Page Title:\s*(.+)/)?.[1]?.trim();
}

function extractConsoleSummary(stdout: string): string | undefined {
  return stdout.match(/Console:\s*(.+)/)?.[1]?.trim();
}

function extractSnapshotYaml(stdout: string): string | undefined {
  const match = stdout.match(/### Snapshot\s*```yaml\s*([\s\S]*?)```/);
  return match?.[1]?.trimEnd();
}

function extractRefs(snapshot: string): SnapshotRefEvidence[] {
  const refs: SnapshotRefEvidence[] = [];
  let latest: SnapshotRefEvidence | undefined;
  for (const line of snapshot.split("\n")) {
    const refMatch = line.match(
      /-\s+([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:"([^"]*)")?.*?\[ref=([a-z]?\d+)\]/,
    );
    if (refMatch) {
      latest = {
        role: refMatch[1],
        name: refMatch[2],
        ref: refMatch[3],
      };
      refs.push(latest);
      continue;
    }
    const urlMatch = line.match(/-\s+\/url:\s*(.+)$/);
    if (urlMatch && latest) {
      latest.href = stripYamlScalarQuotes(urlMatch[1].trim());
    }
  }
  return refs;
}

function stripYamlScalarQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function selectorArg(command: string, args: string[]): string | undefined {
  if (command === "goto" || command === "open") return args[0];
  if (
    command === "click" ||
    command === "dblclick" ||
    command === "hover" ||
    command === "fill" ||
    command === "press" ||
    command === "snapshot" ||
    command === "generate-locator"
  ) {
    return args[0];
  }
  return undefined;
}

export function selectorCandidatesForSnapshotRef(
  ref: SnapshotRefEvidence,
): SelectorDiagnosticCandidate[] {
  const candidates: SelectorDiagnosticCandidate[] = [];
  if (ref.href) {
    const href = normalizeHref(ref.href);
    candidates.push({
      selector: `a[href=${JSON.stringify(href)}]`,
      selectorKind: "css",
      stability: "strong",
      reason: "anchor href from Playwright snapshot",
    });
    candidates.push({
      selector: `xpath=//a[contains(@href, ${xpathLiteral(href)})]`,
      selectorKind: "xpath",
      stability: "medium",
      reason: "relative XPath anchored by href",
    });
  }
  if (ref.name && isRoleLocatorRole(ref.role)) {
    candidates.push({
      selector: `role=${ref.role}[name=${JSON.stringify(ref.name)}]`,
      selectorKind: "playwright",
      stability: ref.href ? "medium" : "strong",
      reason: "role and accessible name from Playwright snapshot",
    });
  }
  if (ref.name) {
    candidates.push({
      selector: `text=${JSON.stringify(ref.name)}`,
      selectorKind: "playwright",
      stability: "weak",
      reason: "visible text from Playwright snapshot",
    });
  }
  return dedupeCandidates(candidates);
}

function selectorCandidatesForSelector(
  selector: string | undefined,
): SelectorDiagnosticCandidate[] {
  if (!selector) return [];
  return [
    {
      selector,
      selectorKind: selectorDiagnosticKind(selector),
      stability: selector.match(/^(?:aria-ref=)?[a-z]?\d+$/i)
        ? "weak"
        : "medium",
      reason: "raw selector argument from Playwright CLI command",
    },
  ];
}

function selectorDiagnosticKind(
  selector: string,
): SelectorDiagnosticCandidate["selectorKind"] {
  const kind = classifySelector(selector);
  return kind === "unknown" ? "css" : kind;
}

function bestSelector(
  rawSelector: string | undefined,
  candidates: SelectorDiagnosticCandidate[],
): string {
  const strong = candidates.find(
    (candidate) => candidate.stability === "strong",
  );
  if (strong) return strong.selector;
  const medium = candidates.find(
    (candidate) => candidate.stability === "medium",
  );
  if (medium) return medium.selector;
  return rawSelector || candidates[0]?.selector || "";
}

function normalizeHref(href: string): string {
  try {
    const parsed = new URL(href, "https://www.instagram.com");
    if (
      parsed.hostname === "www.instagram.com" ||
      parsed.hostname === "instagram.com"
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Keep original href.
  }
  return href;
}

function isRoleLocatorRole(role: string): boolean {
  return [
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "combobox",
    "option",
  ].includes(role);
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}

function dedupeCandidates(
  candidates: SelectorDiagnosticCandidate[],
): SelectorDiagnosticCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.selectorKind}:${candidate.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
