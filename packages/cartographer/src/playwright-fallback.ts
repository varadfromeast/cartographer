import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import type { Action } from "@browserbasehq/stagehand";
import type {
  BrowserFallbackRecorder,
  CreateFallbackTapeInput,
  Domain,
  ElementLocatorStrategy,
  EvidenceArtifact,
  EvidenceStore,
  FallbackOperation,
  FallbackTape,
  LocatedElement,
  LocateElementInput,
  OpType,
  ProcessArg,
  RecordStepOptions,
  SelectorCandidate,
  SelectorPolicy,
  State,
  StateActionCache,
  TaskId,
  TaskSegmentId,
  StepSelectorDiagnostics,
  StepValidator,
  TapeStep,
} from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { actionToAtom, shapeUrl } from "./state-identity.js";
import { browserProfileDir } from "./paths.js";
import { sha256 } from "./hash.js";
import { FileEvidenceStore } from "./evidence-store.js";
import {
  classifySelector,
  locatorForSelector,
  playwrightLocatorCodeForSelector,
} from "./playwright-selector.js";
import { connectOrStartTaskBrowser } from "./task-browser.js";
import {
  appendSegmentOperation,
  readSegmentOperations,
} from "./segment-journal.js";
import { waitForPageLoginIfNeeded } from "./login-wait.js";

interface LastBrowserStep {
  before: State;
  after: State;
  action: Action;
  instruction: string;
  type: OpType;
  atomId: string;
  validators: StepValidator[];
  selectorDiagnostics?: StepSelectorDiagnostics;
}

type ResolvedTarget = {
  selector: string;
  selectorKind: "xpath" | "css" | "url" | "playwright";
  locator: Locator;
  diagnostics?: StepSelectorDiagnostics;
  description: string;
};

export class StabilityFirstSelectorPolicy implements SelectorPolicy {
  choose(candidates: SelectorCandidate[]): SelectorCandidate {
    const ranked = [...candidates].sort((a, b) => score(b) - score(a));
    const selected =
      ranked.find((candidate) => candidate.matchCount === 1) || ranked[0];
    if (!selected) throw new Error("No selector candidates were generated.");
    return selected;
  }
}

export class PlaywrightElementLocatorStrategy
  implements ElementLocatorStrategy
{
  constructor(
    private readonly page: Page,
    private readonly selectorPolicy: SelectorPolicy = new StabilityFirstSelectorPolicy(),
  ) {}

  async locate(input: LocateElementInput): Promise<LocatedElement> {
    if (input.selector.startsWith("xpath=") || input.selector.startsWith("/")) {
      const selector = input.selector.startsWith("xpath=")
        ? input.selector
        : `xpath=${input.selector}`;
      return {
        selector,
        selectorKind: "xpath",
        description: input.actionDescription,
        alternatives: [
          {
            selector,
            selectorKind: "xpath",
            stability: selector.startsWith("xpath=/html") ? "weak" : "medium",
            reason: "agent-provided xpath",
          },
        ],
      };
    }
    const locator = locatorForSelector(this.page, input.selector).first();
    if (!locator.elementHandle) {
      throw new Error(`Could not inspect selector: ${input.selector}`);
    }
    const handle = await locator.elementHandle({ timeout: 10000 });
    if (!handle)
      throw new Error(`Could not resolve selector: ${input.selector}`);
    const candidates = await handle.evaluate((element) => {
      type Candidate = {
        selector: string;
        selectorKind: "xpath" | "css" | "playwright";
        stability: "strong" | "medium" | "weak";
        reason: string;
      };

      function quote(value: string): string {
        if (!value.includes("'")) return `'${value}'`;
        if (!value.includes('"')) return `"${value}"`;
        return `concat(${value
          .split("'")
          .map((part) => `'${part}'`)
          .join(`, "'", `)})`;
      }

      function cssEscape(value: string): string {
        return CSS.escape(value);
      }

      function selectorValue(value: string): string {
        return JSON.stringify(value.replace(/\s+/g, " ").trim());
      }

      function absoluteXPath(node: Element): string {
        function stepFor(currentNode: Element): string {
          const tag = currentNode.tagName.toLowerCase();
          let index = 1;
          let sibling = currentNode.previousElementSibling;
          while (sibling) {
            if (sibling.tagName.toLowerCase() === tag) index += 1;
            sibling = sibling.previousElementSibling;
          }
          return `${tag}[${index}]`;
        }

        const steps: string[] = [];
        let current: Element | null = node;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          steps.unshift(stepFor(current));
          current = current.parentElement;
        }
        return `/${steps.join("/")}`;
      }

      function textCandidate(node: Element): string | null {
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) return null;
        return `//${node.tagName.toLowerCase()}[normalize-space()=${quote(text)}]`;
      }

      function visibleText(node: Element): string | null {
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) return null;
        return text;
      }

      function associatedLabel(node: Element): string | null {
        const labelled = node as HTMLInputElement;
        const labels = labelled.labels ? [...labelled.labels] : [];
        const label = labels
          .map((item) => item.textContent?.replace(/\s+/g, " ").trim())
          .find(Boolean);
        return label && label.length <= 80 ? label : null;
      }

      function inferredRole(node: Element): string | null {
        const explicit = node.getAttribute("role");
        if (explicit) return explicit.split(/\s+/)[0] || null;
        const nodeTag = node.tagName.toLowerCase();
        const type = node.getAttribute("type")?.toLowerCase();
        if (nodeTag === "button") return "button";
        if (nodeTag === "a" && node.hasAttribute("href")) return "link";
        if (nodeTag === "textarea") return "textbox";
        if (nodeTag === "select") return "combobox";
        if (nodeTag === "input") {
          if (["button", "submit", "reset"].includes(type || ""))
            return "button";
          if (["checkbox"].includes(type || "")) return "checkbox";
          if (["radio"].includes(type || "")) return "radio";
          return "textbox";
        }
        return null;
      }

      const tag = element.tagName.toLowerCase();
      const candidates: Candidate[] = [];
      const testId = element.getAttribute("data-testid");
      if (testId) {
        candidates.push({
          selector: `testid=${selectorValue(testId)}`,
          selectorKind: "playwright",
          stability: "strong",
          reason: "Playwright test id locator",
        });
      }

      const role = inferredRole(element);
      const accessibleName =
        element.getAttribute("aria-label") ||
        associatedLabel(element) ||
        visibleText(element) ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder");
      if (role && accessibleName) {
        candidates.push({
          selector: `role=${role}[name=${selectorValue(accessibleName)}]`,
          selectorKind: "playwright",
          stability: "strong",
          reason: "Playwright role locator with accessible name",
        });
      }

      const label = associatedLabel(element);
      if (label) {
        candidates.push({
          selector: `label=${selectorValue(label)}`,
          selectorKind: "playwright",
          stability: "strong",
          reason: "Playwright label locator",
        });
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        candidates.push({
          selector: `placeholder=${selectorValue(placeholder)}`,
          selectorKind: "playwright",
          stability: "strong",
          reason: "Playwright placeholder locator",
        });
      }

      const title = element.getAttribute("title");
      if (title) {
        candidates.push({
          selector: `title=${selectorValue(title)}`,
          selectorKind: "playwright",
          stability: "medium",
          reason: "Playwright title locator",
        });
      }

      if (element.id) {
        candidates.push({
          selector: `xpath=//*[@id=${quote(element.id)}]`,
          selectorKind: "xpath",
          stability: "strong",
          reason: "id attribute",
        });
        candidates.push({
          selector: `#${cssEscape(element.id)}`,
          selectorKind: "css",
          stability: "strong",
          reason: "id css selector",
        });
      }

      for (const attr of [
        "data-testid",
        "aria-label",
        "name",
        "placeholder",
        "title",
        "role",
      ]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        candidates.push({
          selector: `xpath=//${tag}[@${attr}=${quote(value)}]`,
          selectorKind: "xpath",
          stability:
            attr === "data-testid" || attr === "aria-label"
              ? "strong"
              : "medium",
          reason: `${attr} attribute`,
        });
      }

      const byText = textCandidate(element);
      if (byText) {
        const text = visibleText(element);
        if (text) {
          candidates.push({
            selector: `text=${selectorValue(text)}`,
            selectorKind: "playwright",
            stability: "medium",
            reason: "Playwright exact text locator",
          });
        }
        candidates.push({
          selector: `xpath=${byText}`,
          selectorKind: "xpath",
          stability: "medium",
          reason: "short normalized text",
        });
      }

      candidates.push({
        selector: `xpath=${absoluteXPath(element)}`,
        selectorKind: "xpath",
        stability: "weak",
        reason: "absolute fallback path",
      });

      return candidates;
    });
    const withCounts = await Promise.all(
      candidates.map(async (candidate) => {
        const baseSelector = candidate.selector;
        const count = await this.countMatches(baseSelector);

        if (count > 1 && candidate.stability !== "weak") {
          const locator = locatorForSelector(this.page, baseSelector);
          const index = await locator
            .evaluateAll(
              (elements, target) => elements.indexOf(target as Element),
              handle as any,
            )
            .catch(() => -1);

          if (index >= 0) {
            const indexedSelector = `${baseSelector} >> nth=${index}`;
            return {
              ...candidate,
              selector: indexedSelector,
              matchCount: 1,
              reason: `${candidate.reason} (index ${index})`,
            };
          }
        }

        return {
          ...candidate,
          matchCount: count,
        };
      }),
    );
    const selected = this.selectorPolicy.choose(withCounts);
    return {
      selector: selected.selector,
      selectorKind: selected.selectorKind,
      description: input.actionDescription,
      alternatives: withCounts,
    };
  }

  private async countMatches(selector: string): Promise<number> {
    try {
      return await locatorForSelector(this.page, selector).count();
    } catch {
      return 0;
    }
  }
}

export class PlaywrightFallbackRecorder implements BrowserFallbackRecorder {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private entryState: State | null = null;
  private locatorStrategy: ElementLocatorStrategy | null = null;
  private lastStep: LastBrowserStep | null = null;
  private steps: TapeStep[] = [];
  private evidence: EvidenceArtifact[] = [];
  private operations: FallbackOperation[] = [];
  private readonly sessionId: string;
  private readonly recordingStartedAt: string;

  constructor(
    private readonly domain: Domain,
    private readonly actionCache: StateActionCache,
    private readonly evidenceStore: EvidenceStore = new FileEvidenceStore(),
    private readonly attachedBrowser?: {
      browser?: Browser;
      context: BrowserContext;
      page: Page;
    },
    private readonly journal?: {
      taskId: TaskId;
      segmentId: TaskSegmentId;
      eventJournalPath?: string;
    },
  ) {
    this.recordingStartedAt = new Date().toISOString();
    this.sessionId = sha256({
      domain,
      source: "playwright_fallback",
      startedAt: this.recordingStartedAt,
    });
  }

  async open(): Promise<void> {
    if (this.attachedBrowser) {
      this.context = this.attachedBrowser.context;
      this.page = this.attachedBrowser.page;
      this.locatorStrategy = new PlaywrightElementLocatorStrategy(this.page);
      await waitForPageLoginIfNeeded(
        this.page,
        "Instagram login screen detected",
      );
      this.entryState = await this.capture("fallback-entry");
      await this.recordOperation({
        kind: "open",
        instruction: "open session",
        urlBefore: this.page.url(),
        urlAfter: this.page.url(),
        writesToPlatform: false,
        promotionEligible: false,
      });
      return;
    }
    const profileDir =
      process.env.CARTOGRAPHER_BROWSER_PROFILE_DIR ||
      browserProfileDir(this.domain);
    await ensureDir(profileDir);
    this.context = await chromium.launchPersistentContext(profileDir, {
      executablePath:
        process.env.CARTOGRAPHER_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      viewport: { width: 1288, height: 900 },
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.locatorStrategy = new PlaywrightElementLocatorStrategy(this.page);
    await this.page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    await waitForPageLoginIfNeeded(
      this.page,
      "Instagram login screen detected",
    );
    this.entryState = await this.capture("fallback-entry");
    await this.recordOperation({
      kind: "open",
      instruction: "open session",
      urlBefore: this.page.url(),
      urlAfter: this.page.url(),
      writesToPlatform: false,
      promotionEligible: false,
    });
  }

  async close(): Promise<void> {
    if (this.attachedBrowser) {
      return;
    }
    await this.context?.close();
  }

  async goto(url: string): Promise<void> {
    const before = await this.capture("before-goto");
    await this.getPage().goto(url, { waitUntil: "domcontentloaded" });
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage());
    const after = await this.capture("after-goto");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: `goto ${url}`,
      selector: url,
      method: "goto",
      type: "navigate",
      arguments_: [],
      validators: [{ type: "url_equals", value: url }],
      selectorDiagnostics: {
        selected: {
          selector: url,
          selectorKind: "url",
          stability: "strong",
          reason: "direct navigation URL",
          matchCount: 1,
        },
      },
    });
    await this.recordOperation({
      kind: "goto",
      instruction: `goto ${url}`,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: url,
      selectorKind: "url",
      writesToPlatform: false,
    });
  }

  async gotoInbox(): Promise<void> {
    await this.goto("https://www.instagram.com/direct/inbox/");
  }

  async click(selector: string): Promise<void> {
    const before = await this.capture("before-click");
    const target = await this.resolveTarget(selector, `click ${selector}`);
    await target.locator.first().click();
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage());
    const after = await this.capture("after-click");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: target.description,
      selector: target.selector,
      method: "click",
      type: "click",
      arguments_: [],
      validators: [],
      selectorDiagnostics: target.diagnostics,
    });
    await this.recordOperation({
      kind: "click",
      instruction: target.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: target.selector,
      selectorKind: target.selectorKind,
    });
  }

  async dblclick(selector: string): Promise<void> {
    const before = await this.capture("before-dblclick");
    const target = await this.resolveTarget(selector, `dblclick ${selector}`);
    await target.locator.first().dblclick();
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage());
    const after = await this.capture("after-dblclick");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: target.description,
      selector: target.selector,
      method: "dblclick",
      type: "click",
      arguments_: [],
      validators: [],
      selectorDiagnostics: target.diagnostics,
    });
    await this.recordOperation({
      kind: "dblclick",
      instruction: target.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: target.selector,
      selectorKind: target.selectorKind,
    });
  }

  async hover(selector: string): Promise<void> {
    const before = await this.capture("before-hover");
    const target = await this.resolveTarget(selector, `hover ${selector}`);
    await target.locator.first().hover();
    await waitForRenderedPage(this.getPage(), 1000);
    const after = await this.capture("after-hover");
    await this.recordOperation({
      kind: "hover",
      instruction: target.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: target.selector,
      selectorKind: target.selectorKind,
      promotionEligible: false,
    });
  }

  async fill(selector: string, value: string, argName?: string): Promise<void> {
    const before = await this.capture("before-fill");
    const target = await this.resolveTarget(selector, `fill ${selector}`);
    await target.locator.first().fill(value);
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage(), 1000);
    const after = await this.capture("after-fill");
    this.lastStep = this.toLastStep({
      before,
      after,
      instruction: target.description,
      selector: target.selector,
      method: "fill",
      type: "fill",
      arguments_: [argName ? `%${argName}%` : value],
      validators: [],
      selectorDiagnostics: target.diagnostics,
    });
    await this.recordOperation({
      kind: "fill",
      instruction: target.description,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: target.selector,
      selectorKind: target.selectorKind,
      valuePlaceholder: argName ? `%${argName}%` : placeholderForValue(value),
    });
  }

  async type(value: string, options: { submit?: boolean } = {}): Promise<void> {
    const before = await this.capture("before-type");
    await this.getPage().keyboard.type(value);
    if (options.submit) await this.getPage().keyboard.press("Enter");
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage(), 1000);
    const after = await this.capture("after-type");
    await this.recordOperation({
      kind: "type",
      instruction: options.submit ? "type text and press Enter" : "type text",
      urlBefore: before.url,
      urlAfter: after.url,
      valuePlaceholder: placeholderForValue(value),
      writesToPlatform: options.submit,
    });
  }

  async press(key: string): Promise<void> {
    const before = await this.capture("before-press");
    await this.getPage().keyboard.press(key);
    await waitForPageLoginIfNeeded(
      this.getPage(),
      "Instagram login screen detected",
    );
    await waitForRenderedPage(this.getPage(), 1000);
    const after = await this.capture("after-press");
    await this.recordOperation({
      kind: "press",
      instruction: `press ${key}`,
      urlBefore: before.url,
      urlAfter: after.url,
      selector: key,
      selectorKind: "playwright",
      writesToPlatform: isWriteKey(key),
    });
  }

  async wait(milliseconds = 1000): Promise<void> {
    await this.getPage().waitForTimeout(milliseconds);
    await waitForRenderedPage(this.getPage(), 1000);
    await this.recordOperation({
      kind: "wait",
      instruction: `wait ${milliseconds}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      promotionEligible: false,
      writesToPlatform: false,
    });
  }

  async snapshot(target?: string): Promise<string> {
    const selector = target?.trim();
    await waitForRenderedPage(this.getPage());
    const snapshot = await this.captureAriaSnapshot(selector);
    const evidencePath = await this.captureText(
      selector ? `snapshot ${selector}` : "snapshot",
      snapshot,
      "snapshot",
    );
    await this.recordOperation({
      kind: "snapshot",
      instruction: selector ? `snapshot ${selector}` : "snapshot",
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      selector,
      selectorKind: selector ? classifySelector(selector) : undefined,
      evidencePath,
      promotionEligible: false,
    });
    return snapshot;
  }

  async generateLocator(selector: string): Promise<string> {
    const target = await this.resolveTarget(
      selector,
      `generate-locator ${selector}`,
    );
    const generated = await generatedLocatorFor(
      target.locator,
      target.selector,
    );
    const evidencePath = await this.captureText(
      `generated locator ${selector}`,
      generated,
      "generated-locator",
    );
    await this.recordOperation({
      kind: "generate_locator",
      instruction: `generate-locator ${selector}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      selector: target.selector,
      selectorKind: target.selectorKind,
      evidencePath,
      promotionEligible: false,
    });
    return generated;
  }

  async eval(expression: string, target?: string): Promise<string> {
    await waitForRenderedPage(this.getPage(), 1000);
    const result =
      target && target.trim()
        ? await this.resolveTarget(target, `eval ${target}`).then((resolved) =>
            resolved.locator
              .first()
              .evaluate(evaluateSourceInElement, expression),
          )
        : await this.getPage().evaluate(evaluateSourceInPage, expression);
    const text = stringifyEvalResult(result);
    const evidencePath = await this.captureText("eval", text, "eval");
    await this.recordOperation({
      kind: "eval",
      instruction: target ? `eval ${target}` : "eval page",
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      selector: target,
      selectorKind: target ? classifySelector(target) : undefined,
      evidencePath,
      promotionEligible: false,
    });
    return text;
  }

  async text(selector = "body"): Promise<string> {
    await waitForRenderedPage(this.getPage());
    const text = await locatorForSelector(this.getPage(), selector)
      .first()
      .innerText({ timeout: 10000 });
    const evidencePath = await this.captureText(selector, text);
    await this.recordOperation({
      kind: "text",
      instruction: `text ${selector}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      selector,
      selectorKind: classifySelector(selector),
      evidencePath,
    });
    return text;
  }

  async screenshot(label: string): Promise<string> {
    const evidencePath = await this.captureScreenshot(label);
    await this.recordOperation({
      kind: "screenshot",
      instruction: `screenshot ${label}`,
      urlBefore: this.getPage().url(),
      urlAfter: this.getPage().url(),
      evidencePath,
    });
    return evidencePath;
  }

  async recordLastStep(
    name: string,
    options: RecordStepOptions,
  ): Promise<TapeStep> {
    if (!this.lastStep)
      throw new Error("No browser operation has been executed.");
    const now = new Date().toISOString();
    const step: TapeStep = {
      id: sha256({
        name,
        before: this.lastStep.before.id,
        after: this.lastStep.after.id,
        atomId: this.lastStep.atomId,
        createdAt: now,
      }),
      name,
      type: this.lastStep.type,
      before: this.lastStep.before,
      after: this.lastStep.after,
      atomId: this.lastStep.atomId,
      instruction: this.lastStep.instruction,
      actions: [this.lastStep.action],
      status: "recorded",
      validationHash: this.lastStep.after.fingerprint.hash,
      validators: this.lastStep.validators,
      selectorDiagnostics: this.lastStep.selectorDiagnostics,
      writesToPlatform: options.writesToPlatform,
      createdAt: now,
    };
    this.steps.push(step);
    await this.recordOperation({
      kind: "record_step",
      instruction: `record-step ${name}`,
      urlBefore: step.before.url,
      urlAfter: step.after.url,
      selector: step.actions[0]?.selector,
      selectorKind: step.actions[0]?.selector
        ? selectorKind(step.actions[0].selector)
        : undefined,
      stepId: step.id,
      writesToPlatform: step.writesToPlatform,
    });
    await this.actionCache.put({
      version: 1,
      domain: this.domain,
      beforeStateId: step.before.id,
      afterStateId: step.after.id,
      atomId: step.atomId,
      instruction: step.instruction,
      actions: step.actions,
      validationHash: step.validationHash,
      status: "recorded",
      writesToPlatform: step.writesToPlatform,
      updatedAt: now,
    });
    return step;
  }

  async createFallbackTape(
    input: CreateFallbackTapeInput,
  ): Promise<FallbackTape> {
    const journalOperations = await readSegmentOperations(
      this.journal?.eventJournalPath,
    );
    const journalHasMaterial = journalOperations.some(
      (operation) => operation.promotionEligible !== false,
    );
    if (!this.hasAcquisitionMaterial() && !journalHasMaterial) {
      throw new Error(
        "A fallback tape needs at least one operation or recorded step.",
      );
    }
    const now = new Date().toISOString();
    const argNames = unique([
      ...input.argNames,
      ...placeholderArgNames(this.steps),
    ]);
    const args: ProcessArg[] = argNames.map((argName) => ({
      name: argName,
      required: true,
      description: `${argName} argument`,
    }));
    const operations = journalOperations.length
      ? sortOperations(journalOperations)
      : this.operations;
    return {
      id: sha256({
        domain: this.domain,
        intent: input.intent,
        stepIds: this.steps.map((step) => step.id),
        operationIds: operations.map((operation) => operation.id),
        createdAt: now,
      }),
      domain: this.domain,
      intent: input.intent,
      sessionId: this.sessionId,
      source: "playwright_fallback",
      status: "succeeded",
      entry:
        this.steps[0]?.before ||
        this.entryState ||
        (await this.capture("fallback-entry")),
      steps: this.steps,
      operations,
      evidence: this.evidence,
      args,
      writesToPlatform:
        input.writesToPlatform ||
        this.steps.some((step) => step.writesToPlatform),
      recordingStartedAt: this.recordingStartedAt,
      createdAt: now,
      completedAt: now,
    };
  }

  hasAcquisitionMaterial(): boolean {
    return (
      this.steps.length > 0 ||
      this.operations.some((operation) => operation.promotionEligible !== false)
    );
  }

  private toLastStep(input: {
    before: State;
    after: State;
    instruction: string;
    selector: string;
    method: string;
    type: OpType;
    arguments_: string[];
    validators: StepValidator[];
    selectorDiagnostics?: StepSelectorDiagnostics;
  }): LastBrowserStep {
    const action: Action = {
      selector: input.selector,
      method: input.method,
      description: input.instruction,
      arguments: input.arguments_,
    };
    const atom = actionToAtom(action, input.instruction, this.domain);
    return {
      before: input.before,
      after: input.after,
      action,
      instruction: input.instruction,
      type: input.type,
      atomId: atom.id,
      validators: input.validators,
      selectorDiagnostics: input.selectorDiagnostics,
    };
  }

  private async capture(label: string): Promise<State> {
    const url = this.getPage().url();
    const evidencePath = await this.captureScreenshot(label);
    const urlShape = shapeUrl(url);
    const hash = sha256({ atomIds: [], kind: "unknown", urlShape });
    return {
      id: hash,
      domain: this.domain,
      url,
      kind: "unknown",
      fingerprint: {
        hash,
        atomIds: [],
        urlShape,
        atomCount: 0,
      },
      atoms: [],
      observedAt: new Date().toISOString(),
      evidencePath,
    };
  }

  private async captureScreenshot(label: string): Promise<string> {
    const artifact = await this.evidenceStore.captureScreenshot({
      domain: this.domain,
      label,
      screenshot: () => this.getPage().screenshot(),
    });
    this.evidence.push(artifact);
    return artifact.path;
  }

  private async captureText(
    selector: string,
    text: string,
    label = "text",
  ): Promise<string> {
    const artifact = await this.evidenceStore.captureText({
      domain: this.domain,
      label,
      selector,
      text,
    });
    this.evidence.push(artifact);
    return artifact.path;
  }

  private getPage(): Page {
    if (!this.page)
      throw new Error("Playwright fallback recorder is not open.");
    return this.page;
  }

  private getLocatorStrategy(): ElementLocatorStrategy {
    if (!this.locatorStrategy)
      throw new Error("Playwright fallback recorder is not open.");
    return this.locatorStrategy;
  }

  private async resolveTarget(
    selector: string,
    actionDescription: string,
  ): Promise<ResolvedTarget> {
    const located = await this.getLocatorStrategy().locate({
      selector,
      actionDescription,
    });
    return {
      selector: located.selector,
      selectorKind: located.selectorKind,
      locator: locatorForSelector(this.getPage(), located.selector) as Locator,
      diagnostics: selectorDiagnosticsFromLocated(located),
      description: located.description,
    };
  }

  private async captureAriaSnapshot(target?: string): Promise<string> {
    const locator = target
      ? locatorForSelector(this.getPage(), target).first()
      : this.getPage().locator("body").first();
    const withSnapshot = locator as unknown as {
      ariaSnapshot?: (options?: {
        timeout?: number;
        mode?: string;
      }) => Promise<string>;
    };
    if (withSnapshot.ariaSnapshot) {
      return await withSnapshot.ariaSnapshot({ timeout: 5000, mode: "ai" });
    }
    return await locator.innerText({ timeout: 10000 });
  }

  private async recordOperation(
    input: Omit<FallbackOperation, "id" | "createdAt">,
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const operation = {
      id: sha256({
        sessionId: this.sessionId,
        index: this.operations.length,
        kind: input.kind,
        instruction: input.instruction,
        createdAt,
      }),
      createdAt,
      surface: "fallback" as const,
      promotionEligible: true,
      ...input,
    };
    this.operations.push(operation);
    if (this.journal) {
      await appendSegmentOperation({
        domain: this.domain,
        taskId: this.journal.taskId,
        segmentId: this.journal.segmentId,
        operation,
      });
    }
  }
}

function sortOperations(operations: FallbackOperation[]): FallbackOperation[] {
  return [...operations].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || ""),
  );
}

function score(candidate: SelectorCandidate): number {
  const stabilityScore =
    candidate.stability === "strong"
      ? 300
      : candidate.stability === "medium"
        ? 200
        : 100;
  const uniquenessScore =
    candidate.matchCount === 1 ? 50 : candidate.matchCount === 0 ? -50 : 0;
  return stabilityScore + uniquenessScore;
}

function selectorDiagnosticsFromLocated(
  located: LocatedElement,
): StepSelectorDiagnostics {
  const selectedAlternative = located.alternatives?.find(
    (candidate) => candidate.selector === located.selector,
  );
  return {
    selected: {
      selector: located.selector,
      selectorKind: located.selectorKind,
      stability: selectedAlternative?.stability || "medium",
      reason: selectedAlternative?.reason || "selected replay selector",
      matchCount: selectedAlternative?.matchCount,
    },
    alternatives: located.alternatives?.map((candidate) => ({
      selector: candidate.selector,
      selectorKind: candidate.selectorKind,
      stability: candidate.stability,
      reason: candidate.reason,
      matchCount: candidate.matchCount,
    })),
  };
}

function selectorKind(selector: string): FallbackOperation["selectorKind"] {
  return classifySelector(selector);
}

function placeholderForValue(value: string): string | undefined {
  const match = value.match(/^%[a-zA-Z][a-zA-Z0-9_]*%$/);
  return match ? match[0] : undefined;
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

async function generatedLocatorFor(
  locator: Locator,
  fallbackSelector: string,
): Promise<string> {
  const maybeNormalized = locator as unknown as {
    normalize?: () => Promise<{ toString(): string } | string>;
  };
  try {
    const normalized = await maybeNormalized.normalize?.();
    if (normalized) return normalized.toString();
  } catch {
    // Playwright 1.52 does not expose the CLI locator normalizer publicly.
  }
  return playwrightLocatorCodeForSelector(fallbackSelector);
}

async function waitForRenderedPage(page: Page, timeout = 8000): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(500).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        if ((body.innerText || "").replace(/\s+/g, " ").trim().length > 20)
          return true;
        return Boolean(
          body.querySelector(
            'main, article, nav, [role="main"], [role="button"], input, textarea',
          ),
        );
      },
      undefined,
      { timeout },
    )
    .catch(() => {});
}

async function evaluateSourceInPage(source: string): Promise<unknown> {
  const value = (0, eval)(source);
  if (typeof value === "function") return await value();
  return value;
}

async function evaluateSourceInElement(
  element: Element,
  source: string,
): Promise<unknown> {
  const value = (0, eval)(source);
  if (typeof value === "function") return await value(element);
  return value;
}

function stringifyEvalResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function isWriteKey(key: string): boolean {
  return ["Enter", "NumpadEnter"].includes(key);
}

type FallbackPromptCommand = {
  run(rest: string[]): Promise<boolean | void>;
};

function createFallbackCommandTable(input: {
  recorder: PlaywrightFallbackRecorder;
  inputOptions: {
    intent: string;
  };
  saveFallback(tape: FallbackTape): Promise<void>;
}): Map<string, FallbackPromptCommand> {
  const recorder = input.recorder;
  const commands = new Map<string, FallbackPromptCommand>();
  const add = (name: string, run: FallbackPromptCommand["run"]) =>
    commands.set(name, { run });

  add("help", async () => printPlaywrightFallbackHelp());
  add("open", async (rest) => {
    const url = rest.join(" ");
    if (url) {
      await recorder.goto(url);
      console.log(`ok open ${url}`);
    } else {
      console.log("ok open session");
    }
  });
  add("goto", async (rest) => {
    const url = rest.join(" ");
    if (!url) return printUsage("goto <url>");
    await recorder.goto(url);
    console.log(`ok goto ${url}`);
  });
  add("goto-inbox", async () => {
    await recorder.gotoInbox();
    console.log("ok goto inbox");
  });
  add("click", async (rest) => {
    const selector = rest.join(" ");
    if (!selector) return printUsage("click <ref-or-selector>");
    await recorder.click(selector);
    console.log(`ok click ${selector}`);
  });
  add("dblclick", async (rest) => {
    const selector = rest.join(" ");
    if (!selector) return printUsage("dblclick <ref-or-selector>");
    await recorder.dblclick(selector);
    console.log(`ok dblclick ${selector}`);
  });
  add("hover", async (rest) => {
    const selector = rest.join(" ");
    if (!selector) return printUsage("hover <ref-or-selector>");
    await recorder.hover(selector);
    console.log(`ok hover ${selector}`);
  });
  add("fill", async (rest) => {
    const selector = rest[0];
    const value = rest.slice(1).join(" ");
    if (!selector || !value)
      return printUsage("fill <ref-or-selector> <value>");
    await recorder.fill(selector, value);
    console.log(`ok fill ${selector}`);
  });
  add("fill-arg", async (rest) => {
    const selector = rest[0];
    const argName = rest[1];
    const value = rest.slice(2).join(" ");
    if (!selector || !argName || !value)
      return printUsage("fill-arg <ref-or-selector> <arg-name> <value>");
    await recorder.fill(selector, value, argName);
    console.log(`ok fill ${selector} as %${argName}%`);
  });
  add("type", async (rest) => {
    const value = rest.filter((part) => part !== "--submit").join(" ");
    if (!value) return printUsage("type <text> [--submit]");
    await recorder.type(value, { submit: rest.includes("--submit") });
    console.log("ok type");
  });
  add("press", async (rest) => {
    const key = rest.join(" ");
    if (!key) return printUsage("press <key>");
    await recorder.press(key);
    console.log(`ok press ${key}`);
  });
  add("wait", async (rest) => {
    const milliseconds = Number(rest[0] || 1000);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return printUsage("wait [milliseconds]");
    }
    await recorder.wait(milliseconds);
    console.log(`ok wait ${milliseconds}`);
  });
  add("snapshot", async (rest) => {
    console.log(await recorder.snapshot(rest.join(" ") || undefined));
  });
  add("generate-locator", async (rest) => {
    const selector = rest.join(" ");
    if (!selector) return printUsage("generate-locator <ref-or-selector>");
    console.log(await recorder.generateLocator(selector));
  });
  add("eval", async (rest) => {
    const targetFlagIndex = rest.indexOf("--target");
    const target =
      targetFlagIndex >= 0 ? rest.slice(targetFlagIndex + 1).join(" ") : "";
    const expression =
      targetFlagIndex >= 0
        ? rest.slice(0, targetFlagIndex).join(" ")
        : rest.join(" ");
    if (!expression)
      return printUsage(
        "eval <js-expression-or-function> [--target <ref-or-selector>]",
      );
    console.log(await recorder.eval(expression, target || undefined));
  });
  add("text", async (rest) => {
    console.log(await recorder.text(rest.join(" ") || "body"));
  });
  add("screenshot", async (rest) => {
    const label = rest.join("-") || "fallback";
    console.log(await recorder.screenshot(label));
  });
  add("record-step", async (rest) => {
    const name = rest.find((part) => !part.startsWith("--"));
    if (!name) return printUsage("record-step <name> [--write]");
    const step = await recorder.recordLastStep(name, {
      writesToPlatform: rest.includes("--write"),
    });
    console.log(
      `step ${step.name} ${step.id.slice(0, 10)} write=${step.writesToPlatform}`,
    );
  });
  add("save-fallback", async (rest) => {
    const tape = await recorder.createFallbackTape({
      intent: input.inputOptions.intent,
      argNames: collectFlagValues(rest, "--arg"),
      writesToPlatform: rest.includes("--write"),
    });
    await input.saveFallback(tape);
  });
  add("quit", async () => false);
  add("exit", async () => false);

  return commands;
}

function printUsage(usage: string): void {
  console.log(`Usage: ${usage}`);
}

function printSavedFallbackNextActions(
  inputOptions: {
    domain: Domain;
    requiredReviewCommand?: string;
  },
  savedFallback: {
    fallbackTapeId: string;
    reviewRequestPath?: string;
    decisionSchemaPath?: string;
    decisionTemplatePath?: string;
    applyDecisionCommand?: string;
  },
  tape: FallbackTape,
): void {
  console.log(
    `review ${
      inputOptions.requiredReviewCommand ||
      `node packages/cartographer/dist/cli.js end-task-review ${inputOptions.domain} --since ${JSON.stringify(tape.createdAt)}`
    }`,
  );
  console.log(
    JSON.stringify(
      {
        event: "acquisition_packet_saved",
        requiredNextAction: "review_acquisition_packet",
        fallbackTapeId: savedFallback.fallbackTapeId,
        reviewRequestPath: savedFallback.reviewRequestPath,
        decisionSchemaPath: savedFallback.decisionSchemaPath,
        decisionTemplatePath: savedFallback.decisionTemplatePath,
        applyDecisionCommand: savedFallback.applyDecisionCommand,
      },
      null,
      2,
    ),
  );
}

export async function runPlaywrightFallbackPrompt(inputOptions: {
  domain: Domain;
  intent: string;
  taskId?: TaskId;
  taskSegmentId?: TaskSegmentId;
  taskSegmentPath?: string;
  eventJournalPath?: string;
  requiredReviewCommand?: string;
  scriptedCommands?: string[];
  actionCache: StateActionCache;
  saveFallback: (tape: FallbackTape) => Promise<{
    fallbackTapeId: string;
    reviewRequestPath?: string;
    decisionSchemaPath?: string;
    decisionTemplatePath?: string;
    applyDecisionCommand?: string;
  }>;
}): Promise<void> {
  const taskBrowser = inputOptions.taskId
    ? await connectOrStartTaskBrowser(inputOptions.domain, inputOptions.taskId)
    : undefined;
  const recorder = new PlaywrightFallbackRecorder(
    inputOptions.domain,
    inputOptions.actionCache,
    undefined,
    taskBrowser,
    inputOptions.taskId && inputOptions.taskSegmentId
      ? {
          taskId: inputOptions.taskId,
          segmentId: inputOptions.taskSegmentId,
          eventJournalPath: inputOptions.eventJournalPath,
        }
      : undefined,
  );
  await recorder.open();
  console.log("Opened Instagram in a Playwright Chrome session.");
  console.log(`Fallback intent: ${inputOptions.intent}`);
  if (inputOptions.taskId) console.log(`Task ID: ${inputOptions.taskId}`);
  if (inputOptions.taskSegmentId)
    console.log(`Segment ID: ${inputOptions.taskSegmentId}`);
  if (inputOptions.taskSegmentPath)
    console.log(`Segment file: ${inputOptions.taskSegmentPath}`);
  printPlaywrightFallbackHelp();

  const rl = readline.createInterface({ input, output });
  let savedFallback: {
    fallbackTapeId: string;
    reviewRequestPath?: string;
    decisionSchemaPath?: string;
    decisionTemplatePath?: string;
    applyDecisionCommand?: string;
  } | null = null;
  const commandTable = createFallbackCommandTable({
    recorder,
    inputOptions,
    saveFallback: async (tape) => {
      savedFallback = await inputOptions.saveFallback(tape);
      console.log(
        `fallback ${tape.id.slice(0, 10)} steps=${tape.steps.length} write=${tape.writesToPlatform}`,
      );
      printSavedFallbackNextActions(inputOptions, savedFallback, tape);
    },
  });

  const executeCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = splitCommandLine(line);
    if (!cmd) return true;

    try {
      const command = commandTable.get(cmd);
      if (!command) {
        console.log(`Unknown fallback command: ${cmd}`);
        return true;
      }
      const shouldContinue = await command.run(rest);
      return shouldContinue !== false;
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            event: "fallback_command_failed",
            command: cmd,
            line,
            recoverable: true,
            guidance:
              "Do not restart fallback. Try another selector or inspect page text/screenshot in this same session.",
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
    return true;
  };

  try {
    if (inputOptions.scriptedCommands?.length) {
      for (const line of inputOptions.scriptedCommands) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        console.log(`cartographer:fallback> ${trimmed}`);
        const shouldContinue = await executeCommand(trimmed);
        if (!shouldContinue) break;
      }
    } else {
      for (;;) {
        const line = (await rl.question("cartographer:fallback> ")).trim();
        if (!line) continue;
        const shouldContinue = await executeCommand(line);
        if (!shouldContinue) break;
      }
    }
    if (!savedFallback) {
      try {
        const tape = await recorder.createFallbackTape({
          intent: inputOptions.intent,
          argNames: [],
          writesToPlatform: false,
        });
        savedFallback = await inputOptions.saveFallback(tape);
        console.log(
          `auto-saved-acquisition-packet ${tape.id.slice(0, 10)} steps=${tape.steps.length} operations=${tape.operations?.length || 0} write=${tape.writesToPlatform}`,
        );
        printSavedFallbackNextActions(inputOptions, savedFallback, tape);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("at least one operation")
        ) {
          throw error;
        }
      }
    }
  } finally {
    rl.close();
    await recorder.close();
  }
}

function printPlaywrightFallbackHelp(): void {
  console.log(`fallback commands:
  open [url]
  goto <url>
  goto-inbox
  snapshot [ref-or-selector]
  click <ref-or-selector>
  dblclick <ref-or-selector>
  hover <ref-or-selector>
  fill <ref-or-selector> <value>
  fill-arg <ref-or-selector> <arg-name> <value>
  type <text> [--submit]
  press <key>
  wait [milliseconds]
  eval <js-expression-or-function> [--target <ref-or-selector>]
  generate-locator <ref-or-selector>
  text [selector]
  screenshot <label>
  record-step <name> [--write]
  save-fallback [--write] [--arg message]
  quit

Selector/action failures are recoverable. Keep this fallback session open and try a better selector instead of starting another fallback.`);
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
