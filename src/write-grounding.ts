import type {
  CachedActionDiscovery,
  FallbackOperation,
  Postcondition,
  SelectorDiagnosticCandidate,
  WriteGroundingCandidate,
  WriteGroundingSummary,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { classifySelector, locatorForSelector } from "./playwright-selector.js";

type PageLike = {
  url(): string;
};

interface ProbeInput {
  page: PageLike;
  command: string;
  args: string[];
  targetSelector?: string;
  targetName?: string;
  targetRole?: string;
  selectorCandidates: SelectorDiagnosticCandidate[];
  urlBefore?: string;
  urlAfter?: string;
}

interface ElementProbe {
  role?: string;
  accessibleName?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  ariaDescription?: string;
  contenteditable?: boolean;
  formOwner?: string;
  nearbyStableText?: string;
  writeTargetCount: number;
}

export async function probeWriteGrounding(
  input: ProbeInput,
): Promise<{
  summary?: WriteGroundingSummary;
  selectorCandidates: SelectorDiagnosticCandidate[];
  actionDiscovery?: CachedActionDiscovery;
}> {
  if (!isWriteAdjacent(input)) {
    return { selectorCandidates: input.selectorCandidates };
  }

  const seedCandidates = selectorSeeds(input);
  const candidates: WriteGroundingCandidate[] = [];
  const queue = [...seedCandidates];
  const seenSeeds = new Set(queue.map((candidate) => candidate.selector));
  for (let index = 0; index < queue.length; index += 1) {
    const seed = queue[index];
    const probe = await probeSelector(input.page, seed.selector);
    const scored = scoreWriteSelector({
      seed,
      probe,
      urlScope: urlScope(input.urlAfter || input.urlBefore || input.page.url()),
    });
    candidates.push(scored);
    for (const derived of selectorsFromProbe(probe.metadata)) {
      if (seenSeeds.has(derived.selector)) continue;
      seenSeeds.add(derived.selector);
      queue.push(derived);
    }
  }

  const sorted = dedupeGroundingCandidates(candidates).sort(
    (left, right) => right.score - left.score,
  );
  const recommended = sorted.find((candidate) => candidate.promotionReady);
  const postconditionHints = renderedPostconditionHints(input, recommended);
  const warnings = groundingWarnings(input, sorted, recommended);
  const summary: WriteGroundingSummary = {
    command: input.command,
    writeAdjacent: true,
    urlScope: urlScope(input.urlAfter || input.urlBefore || input.page.url()),
    recommendedSelector: recommended?.selector,
    promotionReady: Boolean(recommended),
    candidates: sorted,
    postconditionHints,
    warnings,
  };
  return {
    summary,
    selectorCandidates: mergeSelectorScores(input.selectorCandidates, sorted),
    actionDiscovery: createActionDiscovery(input, sorted),
  };
}

export function scoreWriteSelector(input: {
  seed: SelectorDiagnosticCandidate;
  probe: {
    matchCount: number;
    visible: boolean;
    enabled: boolean;
    metadata?: ElementProbe;
  };
  urlScope?: string;
}): WriteGroundingCandidate {
  const reasons: string[] = [];
  const penalties: string[] = [];
  let score = 0;
  const selector = input.seed.selector;

  if (/^(?:aria-ref=)?[a-z]?\d+$/i.test(selector)) {
    score -= 100;
    penalties.push("raw snapshot refs are not durable write selectors");
  }
  if (input.seed.selectorKind === "xpath") {
    score += selector.startsWith("xpath=/html") ? -60 : -15;
    penalties.push(
      selector.startsWith("xpath=/html")
        ? "generated absolute XPath depends on document position"
        : "XPath is weaker than semantic locator forms",
    );
  }
  if (/:(?:nth-child|nth-of-type)\(/.test(selector)) {
    score -= 20;
    penalties.push("selector depends on current DOM ordering");
  }
  if (/role=/.test(selector)) {
    score += 30;
    reasons.push("role/name locator");
  }
  if (/label=/.test(selector)) {
    score += 26;
    reasons.push("label locator");
  }
  if (/placeholder=/.test(selector)) {
    score += 24;
    reasons.push("placeholder locator");
  }
  if (/\[aria-(?:label|description)=/.test(selector)) {
    score += 20;
    reasons.push("aria attribute selector");
  }
  if (/contenteditable/.test(selector)) {
    score += 14;
    reasons.push("contenteditable write surface");
  }
  if (input.probe.matchCount === 1) {
    score += 18;
    reasons.push("unique match");
  } else if (input.probe.matchCount > 1) {
    score -= 30;
    penalties.push("matches multiple targets");
  } else {
    score -= 45;
    penalties.push("does not resolve in current state");
  }
  if (input.probe.visible) {
    score += 10;
    reasons.push("visible");
  } else {
    score -= 15;
    penalties.push("not visible");
  }
  if (input.probe.enabled) {
    score += 10;
    reasons.push("enabled");
  } else {
    score -= 15;
    penalties.push("disabled");
  }

  const metadata = input.probe.metadata;
  if (metadata?.label) {
    score += 12;
    reasons.push("label evidence");
  }
  if (metadata?.placeholder) {
    score += 10;
    reasons.push("placeholder evidence");
  }
  if (metadata?.ariaLabel || metadata?.ariaDescription) {
    score += 8;
    reasons.push("aria evidence");
  }
  if (metadata?.formOwner) {
    score += 8;
    reasons.push("semantic form ownership");
  }
  if (metadata?.nearbyStableText) {
    score += 6;
    reasons.push("nearby stable text");
  }
  if (input.urlScope) {
    score += 8;
    reasons.push("scoped to URL state");
  }
  if (
    metadata?.accessibleName &&
    hasDynamicAccessibleName(metadata.accessibleName)
  ) {
    score -= 35;
    penalties.push("accessible name looks dynamic or thread-specific");
  }
  if (metadata && metadata.writeTargetCount > 1 && input.probe.matchCount > 1) {
    score -= 20;
    penalties.push("selector matches multiple write-capable elements");
  }

  return {
    selector,
    selectorKind: input.seed.selectorKind,
    score,
    promotionReady:
      score >= 55 &&
      input.probe.matchCount === 1 &&
      input.probe.visible &&
      input.probe.enabled &&
      !/^(?:aria-ref=)?[a-z]?\d+$/i.test(selector),
    reasons,
    penalties,
    matchCount: input.probe.matchCount,
    visible: input.probe.visible,
    enabled: input.probe.enabled,
    role: metadata?.role,
    accessibleName: metadata?.accessibleName,
    placeholder: metadata?.placeholder,
    label: metadata?.label,
    ariaLabel: metadata?.ariaLabel,
    ariaDescription: metadata?.ariaDescription,
    contenteditable: metadata?.contenteditable,
    formOwner: metadata?.formOwner,
    nearbyStableText: metadata?.nearbyStableText,
    urlScope: input.urlScope,
  };
}

function isWriteAdjacent(input: ProbeInput): boolean {
  if (["fill", "type", "press", "check", "uncheck", "select", "upload"].includes(input.command)) {
    return true;
  }
  if (input.command === "click" || input.command === "dblclick") {
    const source = `${input.targetSelector || ""} ${input.targetName || ""} ${input.args.join(" ")}`.toLowerCase();
    return /\b(send|submit|post|publish|save|confirm|done|next)\b/.test(
      source,
    );
  }
  return false;
}

function selectorSeeds(input: ProbeInput): SelectorDiagnosticCandidate[] {
  const seeds = [...input.selectorCandidates, ...commonWriteSelectorSeeds(input)];
  if (input.targetSelector) {
    seeds.push({
      selector: input.targetSelector,
      selectorKind: selectorKind(input.targetSelector),
      stability: /^(?:aria-ref=)?[a-z]?\d+$/i.test(input.targetSelector)
        ? "weak"
        : "medium",
      reason: "raw fallback selector argument",
    });
  }
  if (input.targetRole && input.targetName) {
    seeds.push({
      selector: `role=${input.targetRole}[name=${JSON.stringify(input.targetName)}]`,
      selectorKind: "playwright",
      stability: "strong",
      reason: "role/name candidate from snapshot target",
    });
    if (input.targetRole === "textbox") {
      seeds.push({
        selector: `placeholder=${JSON.stringify(input.targetName)}`,
        selectorKind: "playwright",
        stability: "strong",
        reason: "textbox accessible name may be placeholder text",
      });
    }
  }
  return dedupeSelectorSeeds(seeds);
}

function commonWriteSelectorSeeds(input: ProbeInput): SelectorDiagnosticCandidate[] {
  if (!isWriteAdjacent(input)) return [];
  const seeds: SelectorDiagnosticCandidate[] = [];
  const targetText = stringSelectorValue(input.targetSelector);
  if (targetText) {
    seeds.push({
      selector: `role=textbox[name=${JSON.stringify(targetText)}]`,
      selectorKind: "playwright",
      stability: "strong",
      reason: "textbox role/name derived from requested selector text",
    });
  }
  if (
    input.command === "fill" ||
    input.command === "type" ||
    input.command === "press"
  ) {
    seeds.push(
      {
        selector: "[contenteditable='true']",
        selectorKind: "css",
        stability: "medium",
        reason: "generic contenteditable write target",
      },
      {
        selector: "div[contenteditable='true']",
        selectorKind: "css",
        stability: "medium",
        reason: "generic contenteditable div write target",
      },
      {
        selector: "role=textbox",
        selectorKind: "playwright",
        stability: "medium",
        reason: "generic textbox role target",
      },
    );
    for (const name of ["Message", "Message...", "Search"]) {
      seeds.push({
        selector: `role=textbox[name=${JSON.stringify(name)}]`,
        selectorKind: "playwright",
        stability: "medium",
        reason: "common Instagram textbox accessible name",
      });
    }
  }
  if (input.command === "click" || input.command === "dblclick") {
    for (const name of ["Send", "Next", "Done"]) {
      seeds.push({
        selector: `role=button[name=${JSON.stringify(name)}]`,
        selectorKind: "playwright",
        stability: "medium",
        reason: "common submit button role/name",
      });
    }
  }
  return seeds;
}

function stringSelectorValue(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const match = selector.match(/^(?:placeholder|label|text|title|alt)=(.+)$/);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    try {
      return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function selectorsFromProbe(
  metadata: ElementProbe | undefined,
): SelectorDiagnosticCandidate[] {
  if (!metadata) return [];
  const candidates: SelectorDiagnosticCandidate[] = [];
  if (metadata.label) {
    candidates.push({
      selector: `label=${JSON.stringify(metadata.label)}`,
      selectorKind: "playwright",
      stability: "strong",
      reason: "label text from live write target",
    });
  }
  if (metadata.placeholder) {
    candidates.push({
      selector: `placeholder=${JSON.stringify(metadata.placeholder)}`,
      selectorKind: "playwright",
      stability: "strong",
      reason: "placeholder text from live write target",
    });
  }
  if (metadata.ariaLabel) {
    candidates.push({
      selector: `[aria-label=${JSON.stringify(metadata.ariaLabel)}]`,
      selectorKind: "css",
      stability: "medium",
      reason: "aria-label from live write target",
    });
  }
  if (metadata.role && metadata.accessibleName) {
    candidates.push({
      selector: `role=${metadata.role}[name=${JSON.stringify(metadata.accessibleName)}]`,
      selectorKind: "playwright",
      stability: "strong",
      reason: "role/name from live write target",
    });
  }
  if (metadata.contenteditable && metadata.ariaLabel) {
    candidates.push({
      selector: `[contenteditable='true'][aria-label=${JSON.stringify(metadata.ariaLabel)}]`,
      selectorKind: "css",
      stability: "medium",
      reason: "contenteditable write target with aria-label",
    });
  }
  if (metadata.contenteditable && metadata.placeholder) {
    candidates.push({
      selector: `[contenteditable='true'][data-placeholder=${JSON.stringify(metadata.placeholder)}]`,
      selectorKind: "css",
      stability: "medium",
      reason: "contenteditable write target with placeholder",
    });
  }
  return dedupeSelectorSeeds(candidates);
}

async function probeSelector(
  page: PageLike,
  selector: string,
): Promise<{
  matchCount: number;
  visible: boolean;
  enabled: boolean;
  metadata?: ElementProbe;
}> {
  try {
    const locator = locatorForSelector(page as any, selector);
    const matchCount = await locator.count().catch(() => 0);
    const first = locator.first();
    const visible = matchCount > 0 ? await first.isVisible().catch(() => false) : false;
    const enabled = matchCount > 0 ? await first.isEnabled().catch(() => false) : false;
    const handle =
      matchCount > 0 && first.elementHandle
        ? await first
            .elementHandle({ timeout: 1000 })
            .catch((): null => null)
        : null;
    const metadata = handle
      ? await handle.evaluate((element: Element): ElementProbe => {
          const el = element as HTMLElement;
          const labels =
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement
              ? Array.from(el.labels || [])
                  .map((label) => label.textContent?.trim() || "")
                  .filter(Boolean)
                  .join(" | ")
              : "";
          const form = (el as HTMLInputElement).form;
          const owner = form
            ? [
                form.getAttribute("aria-label"),
                form.getAttribute("name"),
                form.id ? `#${form.id}` : "",
              ]
                .filter(Boolean)
                .join(" ")
            : "";
          const region =
            el.closest("form,[role='dialog'],main,section,article") || el.parentElement;
          const text = (region?.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
          const writeTargets = region
            ? region.querySelectorAll(
                "input, textarea, select, button, [contenteditable='true'], [role='textbox'], [role='button']",
              ).length
            : 0;
          return {
            role: el.getAttribute("role") || undefined,
            accessibleName:
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent?.trim().slice(0, 120) ||
              undefined,
            placeholder:
              el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
                ? el.placeholder || undefined
                : el.getAttribute("data-placeholder") || undefined,
            label: labels || undefined,
            ariaLabel: el.getAttribute("aria-label") || undefined,
            ariaDescription: el.getAttribute("aria-description") || undefined,
            contenteditable: el.isContentEditable,
            formOwner: owner || undefined,
            nearbyStableText: hasDynamicAccessibleName(text) ? undefined : text,
            writeTargetCount: writeTargets,
          };
        })
      : undefined;
    return { matchCount, visible, enabled, metadata };
  } catch {
    return { matchCount: 0, visible: false, enabled: false };
  }
}

function renderedPostconditionHints(
  input: ProbeInput,
  recommended?: WriteGroundingCandidate,
): Postcondition[] {
  const value = input.command === "fill" ? "%message%" : "%value%";
  if (
    [input.urlBefore, input.urlAfter, input.page.url()].some((url) =>
      url?.includes("/direct/t/"),
    )
  ) {
    return [
      { type: "url_contains", value: "/direct/t/" },
      {
        type: "rendered_text_contains",
        selector: "main",
        value,
        excludeSelectors: [
          "[contenteditable='true']",
          "textarea",
          "input",
          "[role='textbox']",
        ],
      },
    ];
  }
  return recommended
    ? [{ type: "selector_exists", selector: recommended.selector }]
    : [];
}

function groundingWarnings(
  input: ProbeInput,
  candidates: WriteGroundingCandidate[],
  recommended?: WriteGroundingCandidate,
): string[] {
  const warnings: string[] = [];
  if (input.targetSelector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i)) {
    warnings.push("write_target_used_raw_snapshot_ref");
  }
  if (!recommended) {
    warnings.push("write_target_needs_rerecord_with_durable_selector");
  }
  if (candidates.some((candidate) => candidate.penalties.length)) {
    warnings.push("write_selector_penalties_present");
  }
  return warnings;
}

function mergeSelectorScores(
  existing: SelectorDiagnosticCandidate[],
  grounded: WriteGroundingCandidate[],
): SelectorDiagnosticCandidate[] {
  const bySelector = new Map<string, SelectorDiagnosticCandidate>();
  for (const candidate of existing) bySelector.set(candidate.selector, candidate);
  for (const candidate of grounded) {
    bySelector.set(candidate.selector, {
      selector: candidate.selector,
      selectorKind: candidate.selectorKind,
      stability: candidate.promotionReady
        ? "strong"
        : candidate.score >= 35
          ? "medium"
          : "weak",
      reason: [
        ...candidate.reasons,
        ...candidate.penalties.map((penalty) => `penalty: ${penalty}`),
      ].join("; "),
      matchCount: candidate.matchCount,
      score: candidate.score,
      scoreReasons: [...candidate.reasons, ...candidate.penalties],
    });
  }
  return [...bySelector.values()].sort(
    (left, right) => (right.score || 0) - (left.score || 0),
  );
}

function createActionDiscovery(
  input: ProbeInput,
  candidates: WriteGroundingCandidate[],
): CachedActionDiscovery {
  const actions = candidates.slice(0, 6).map((candidate) => ({
    description: `${input.command} ${candidate.selector}`,
    method: actionMethod(input.command),
    selector: candidate.selector,
    arguments: input.command === "fill" ? ["%message%"] : input.args,
    score: candidate.score,
    promotionReady: candidate.promotionReady,
  }));
  return {
    cacheKey: sha256({
      source: "write-grounding",
      command: input.command,
      urlScope: urlScope(input.urlAfter || input.urlBefore || input.page.url()),
      targetSelector: input.targetSelector,
      targetName: input.targetName,
    }),
    source: "deterministic_grounding",
    actions,
  };
}

function actionMethod(command: string): "click" | "fill" | "type" | "press" {
  if (command === "fill") return "fill";
  if (command === "type") return "type";
  if (command === "press") return "press";
  return "click";
}

function selectorKind(
  selector: string,
): SelectorDiagnosticCandidate["selectorKind"] {
  const kind = classifySelector(selector);
  return kind === "unknown" ? "css" : kind;
}

function urlScope(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/direct/t/")) return "/direct/t/";
    if (parsed.pathname.startsWith("/direct/inbox")) return "/direct/inbox";
    return parsed.pathname || undefined;
  } catch {
    return undefined;
  }
}

function hasDynamicAccessibleName(value: string): boolean {
  return /\b(\d+\s*(m|h|d|w|mo|yr|mins?|hours?|days?)\s+ago|active now|seen|liked a message|sent an attachment)\b/i.test(
    value,
  );
}

function dedupeSelectorSeeds(
  candidates: SelectorDiagnosticCandidate[],
): SelectorDiagnosticCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.selector || seen.has(candidate.selector)) return false;
    seen.add(candidate.selector);
    return true;
  });
}

function dedupeGroundingCandidates(
  candidates: WriteGroundingCandidate[],
): WriteGroundingCandidate[] {
  const seen = new Map<string, WriteGroundingCandidate>();
  for (const candidate of candidates) {
    const existing = seen.get(candidate.selector);
    if (!existing || candidate.score > existing.score) {
      seen.set(candidate.selector, candidate);
    }
  }
  return [...seen.values()];
}
