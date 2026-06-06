import fs from "node:fs/promises";
import path from "node:path";
import { htmlToMarkdown as mdreamHtmlToMarkdown } from "mdream";
import type { Page } from "playwright";
import type { Domain } from "../contracts.js";
import { ensureDir, writeJsonFile } from "../fs-json.js";
import { sha256 } from "../hash.js";
import { slugifyName } from "../paths.js";
import { shapeUrl } from "../state-identity.js";

export interface SurfaceCapture {
  schemaVersion: 1;
  domain: Domain;
  runId: string;
  captureId: string;
  url: string;
  urlShape: string;
  title?: string;
  capturedAt: string;
  markdown: {
    path: string;
    generator: "mdream";
    preview: string;
    tokenEstimate: number;
  };
  strippedHtml: {
    path: string;
    bytes: number;
  };
  controls: CapturedControl[];
  controlGroups: ControlGroup[];
  screenshot: {
    path: string;
    overlayPath?: string;
    width: number;
    height: number;
  };
  pageStructure: {
    frameCount: number;
    iframeCount: number;
    openShadowRootCount: number;
    landmarkCount: number;
  };
  axTree?: {
    path: string;
    nodeCount: number;
  };
  ariaSnapshot?: {
    path: string;
    bytes: number;
    mode: "ai";
  };
  hashes: {
    surfaceHash: string;
    contentHash: string;
    controlHash: string;
  };
  warnings: string[];
  artifactDir: string;
}

export interface CapturedControl {
  ref: string;
  stableId: string;
  tag: string;
  role: string;
  actionKind: "navigate" | "click" | "input" | "select" | "unknown";
  name?: string;
  text?: string;
  href?: string;
  type?: string;
  disabled: boolean;
  visible: boolean;
  rect: Rect;
  center: { x: number; y: number };
  viewport: {
    inViewport: boolean;
    aboveFold: boolean;
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
    zIndex?: string;
  };
  context: {
    landmark?: string;
    heading?: string;
    label?: string;
    nearbyText?: string;
  };
  ancestry: string[];
  selectorCandidates: SelectorCandidate[];
  riskHints: string[];
  collapsedFrom?: number;
}

export interface SelectorCandidate {
  selector: string;
  kind: "role" | "css" | "text";
  stability: "strong" | "medium" | "weak";
  reason: string;
}

export interface ControlGroup {
  id: string;
  kind: "repeated_controls" | "form_like" | "nav_like";
  itemRefs: string[];
  sharedRole?: string;
  selectorShape?: string;
  layout?: "vertical" | "horizontal" | "clustered";
  sampleNames: string[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CapturedControlWithoutStableId = Omit<CapturedControl, "stableId">;

export async function captureSurface(input: {
  domain: Domain;
  runId: string;
  page: Page;
  outputDir: string;
  index: number;
}): Promise<SurfaceCapture> {
  const capturedAt = new Date().toISOString();
  const url = input.page.url();
  const title = await input.page.title().catch((): undefined => undefined);
  const urlShape = shapeUrl(url);
  const captureId = `${String(input.index).padStart(3, "0")}-${slugifyName(urlShape) || "surface"}`;
  const artifactDir = path.join(input.outputDir, captureId);
  await ensureDir(artifactDir);

  const viewport =
    input.page.viewportSize() ||
    (await input.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })));
  const screenshotPath = path.join(artifactDir, "screenshot.png");
  await input.page.screenshot({ path: screenshotPath, fullPage: false });

  const strippedHtml = await captureStrippedHtml(input.page);
  const strippedHtmlPath = path.join(artifactDir, "stripped.html");
  await fs.writeFile(strippedHtmlPath, `${strippedHtml.trim()}\n`, "utf8");

  const markdownText = mdreamHtmlToMarkdown(strippedHtml, {
    origin: url,
    minimal: false,
    isolateMain: false,
    clean: {
      urls: true,
      fragments: true,
      emptyLinks: true,
      blankLines: true,
      redundantLinks: true,
      selfLinkHeadings: true,
      emptyImages: true,
      emptyLinkText: true,
    },
  });
  const markdownPath = path.join(artifactDir, "surface.md");
  await fs.writeFile(markdownPath, `${markdownText.trim()}\n`, "utf8");

  const controls = withStableControlIds(await extractInteractables(input.page));
  const controlGroups = detectControlGroups(controls);
  const warnings = captureWarnings({ controls, markdownText });
  const pageStructure = await capturePageStructure(input.page).catch(
    (error) => {
      warnings.push(
        `Page structure capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        frameCount: 1,
        iframeCount: 0,
        openShadowRootCount: 0,
        landmarkCount: 0,
      };
    },
  );

  const screenshotOverlayPath = path.join(
    artifactDir,
    "screenshot-overlay.png",
  );
  try {
    await captureControlOverlay(input.page, controls, screenshotOverlayPath);
  } catch (error) {
    warnings.push(
      `Screenshot overlay capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let ariaSnapshot: SurfaceCapture["ariaSnapshot"];
  try {
    const snapshot = await captureAriaSnapshot(input.page);
    const ariaPath = path.join(artifactDir, "aria-snapshot.yml");
    await fs.writeFile(ariaPath, `${snapshot.trim()}\n`, "utf8");
    ariaSnapshot = {
      path: ariaPath,
      bytes: Buffer.byteLength(snapshot, "utf8"),
      mode: "ai",
    };
  } catch (error) {
    warnings.push(
      `ARIA snapshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let axTree: SurfaceCapture["axTree"];
  try {
    const client = await input.page.context().newCDPSession(input.page);
    const tree = await client.send("Accessibility.getFullAXTree");
    const axPath = path.join(artifactDir, "ax-tree.json");
    await writeJsonFile(axPath, tree);
    axTree = {
      path: axPath,
      nodeCount: Array.isArray(tree.nodes) ? tree.nodes.length : 0,
    };
  } catch (error) {
    warnings.push(
      `AX tree capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const contentHash = sha256(markdownText);
  const controlHash = sha256(
    controls.map((control) => ({
      role: control.role,
      name: control.name,
      text: control.text,
      href: control.href,
      selectorCandidates: control.selectorCandidates,
    })),
  );
  const surfaceHash = sha256({ urlShape, title, contentHash, controlHash });

  const capture: SurfaceCapture = {
    schemaVersion: 1,
    domain: input.domain,
    runId: input.runId,
    captureId,
    url,
    urlShape,
    title,
    capturedAt,
    markdown: {
      path: markdownPath,
      generator: "mdream",
      preview: markdownText.replace(/\s+/g, " ").trim().slice(0, 1000),
      tokenEstimate: Math.ceil(markdownText.length / 4),
    },
    strippedHtml: {
      path: strippedHtmlPath,
      bytes: Buffer.byteLength(strippedHtml, "utf8"),
    },
    controls,
    controlGroups,
    screenshot: {
      path: screenshotPath,
      overlayPath: screenshotOverlayPath,
      width: viewport.width,
      height: viewport.height,
    },
    pageStructure,
    axTree,
    ariaSnapshot,
    hashes: {
      surfaceHash,
      contentHash,
      controlHash,
    },
    warnings,
    artifactDir,
  };

  await writeJsonFile(path.join(artifactDir, "surface.json"), capture);
  return capture;
}

function withStableControlIds(
  controls: CapturedControlWithoutStableId[],
): CapturedControl[] {
  return controls.map((control) => ({
    ...control,
    stableId: `c_${sha256({
      role: control.role,
      name: control.name,
      href: control.href,
      type: control.type,
      landmark: control.context.landmark,
      selector: control.selectorCandidates[0]?.selector,
    }).slice(0, 12)}`,
  }));
}

async function capturePageStructure(
  page: Page,
): Promise<SurfaceCapture["pageStructure"]> {
  const frameCount = page.frames().length;
  return await page.evaluate(
    ({ frameCount }) => {
      const countOpenShadowRoots = (root: ParentNode): number => {
        let count = 0;
        for (const element of Array.from(root.querySelectorAll("*"))) {
          const shadowRoot = (element as HTMLElement).shadowRoot;
          if (shadowRoot) count += 1 + countOpenShadowRoots(shadowRoot);
        }
        return count;
      };
      return {
        frameCount,
        iframeCount: document.querySelectorAll("iframe").length,
        openShadowRootCount: countOpenShadowRoots(document),
        landmarkCount: document.querySelectorAll(
          "main,nav,aside,header,footer,form,article,section,[role='main'],[role='navigation'],[role='dialog'],[role='form'],[role='search'],[role='banner'],[role='contentinfo']",
        ).length,
      };
    },
    { frameCount },
  );
}

async function captureControlOverlay(
  page: Page,
  controls: CapturedControl[],
  outputPath: string,
): Promise<void> {
  await page.evaluate((controls) => {
    const previous = document.getElementById(
      "__cartographer_control_overlay__",
    );
    previous?.remove();
    const overlay = document.createElement("div");
    overlay.id = "__cartographer_control_overlay__";
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      fontFamily: "Arial, sans-serif",
    });
    const palette = ["#ff3b30", "#007aff", "#34c759", "#ff9500", "#af52de"];
    for (const [index, control] of controls.entries()) {
      if (!control.viewport.inViewport) continue;
      const color = palette[index % palette.length];
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        left: `${control.rect.x}px`,
        top: `${control.rect.y}px`,
        width: `${Math.max(1, control.rect.width)}px`,
        height: `${Math.max(1, control.rect.height)}px`,
        border: `2px solid ${color}`,
        boxSizing: "border-box",
        borderRadius: "3px",
        background: "rgba(255,255,255,0.03)",
      });
      const label = document.createElement("div");
      label.textContent = control.ref;
      Object.assign(label.style, {
        position: "absolute",
        left: `${control.rect.x}px`,
        top: `${Math.max(0, control.rect.y - 16)}px`,
        background: color,
        color: "white",
        fontSize: "11px",
        lineHeight: "14px",
        padding: "0 4px",
        borderRadius: "2px",
      });
      overlay.append(box, label);
    }
    document.documentElement.append(overlay);
  }, controls);
  await page.screenshot({ path: outputPath, fullPage: false });
  await page.evaluate(() => {
    document.getElementById("__cartographer_control_overlay__")?.remove();
  });
}

async function captureAriaSnapshot(page: Page): Promise<string> {
  const pageWithSnapshot = page as Page & {
    ariaSnapshot?: (options?: {
      timeout?: number;
      mode?: "ai";
    }) => Promise<string>;
  };
  if (pageWithSnapshot.ariaSnapshot) {
    return await pageWithSnapshot.ariaSnapshot({ timeout: 5000, mode: "ai" });
  }

  const locatorWithSnapshot = page.locator("body") as ReturnType<
    Page["locator"]
  > & {
    ariaSnapshot?: (options?: { timeout?: number }) => Promise<string>;
  };
  if (locatorWithSnapshot.ariaSnapshot) {
    return await locatorWithSnapshot.ariaSnapshot({ timeout: 5000 });
  }

  throw new Error("Playwright ariaSnapshot API is unavailable");
}

async function captureStrippedHtml(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll("script, style, noscript, svg, canvas")
      .forEach((element) => element.remove());
    clone.querySelectorAll("img").forEach((image) => {
      const alt =
        image.getAttribute("alt") || image.getAttribute("aria-label") || "";
      const replacement = document.createElement("span");
      replacement.textContent = alt ? `[image: ${alt}]` : "";
      image.replaceWith(replacement);
    });
    clone.querySelectorAll("*").forEach((element) => {
      for (const attr of [...element.attributes]) {
        if (
          attr.name === "style" ||
          attr.name === "class" ||
          attr.name === "src" ||
          attr.name === "srcset" ||
          attr.name === "sizes" ||
          attr.name.startsWith("data-") ||
          attr.name.startsWith("js")
        ) {
          element.removeAttribute(attr.name);
        }
      }
    });
    return clone.innerHTML;
  });
}

async function extractInteractables(
  page: Page,
): Promise<CapturedControlWithoutStableId[]> {
  return await page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[role='menuitem']",
      "[role='option']",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])",
      "[onclick]",
      "[aria-haspopup]",
      "[aria-expanded]",
    ].join(",");

    const cssEscape = (value: string): string => {
      const escaper = (
        window as unknown as { CSS?: { escape?: (s: string) => string } }
      ).CSS?.escape;
      return escaper ? escaper(value) : value.replace(/"/g, '\\"');
    };
    const normalize = (
      value: string | null | undefined,
    ): string | undefined => {
      const normalized = value?.replace(/\s+/g, " ").trim();
      if (!normalized) return undefined;
      const halfLength = normalized.length / 2;
      const deduped =
        normalized.length % 2 === 0 &&
        normalized.slice(0, halfLength) === normalized.slice(halfLength)
          ? normalized.slice(0, halfLength)
          : normalized;
      return deduped.slice(0, 220);
    };
    const roleFor = (element: Element): string => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (["input", "textarea"].includes(tag)) return "textbox";
      if (tag === "select") return "combobox";
      if ((element as HTMLElement).isContentEditable) return "textbox";
      return tag;
    };
    const actionKindFor = (
      element: Element,
      role: string,
    ): "navigate" | "click" | "input" | "select" | "unknown" => {
      const tag = element.tagName.toLowerCase();
      if (
        element instanceof HTMLAnchorElement &&
        element.getAttribute("href") &&
        element.getAttribute("href") !== "#"
      )
        return "navigate";
      if (
        (element as HTMLElement).isContentEditable ||
        ["input", "textarea"].includes(tag)
      )
        return "input";
      if (tag === "select" || role === "combobox" || role === "option")
        return "select";
      if (
        [
          "button",
          "link",
          "menuitem",
          "checkbox",
          "radio",
          "tab",
          "switch",
        ].includes(role) ||
        element.hasAttribute("onclick") ||
        getComputedStyle(element).cursor === "pointer"
      )
        return "click";
      return "unknown";
    };
    const accessibleName = (element: Element): string | undefined =>
      normalize(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          element.textContent,
      );
    const cssPath = (element: Element): string => {
      const id = element.getAttribute("id");
      if (id) return `${element.tagName.toLowerCase()}#${cssEscape(id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 4) {
        const parent = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter(
          (candidate) => candidate.tagName === current?.tagName,
        );
        const index = siblings.indexOf(current) + 1;
        parts.unshift(
          siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag,
        );
        current = parent;
      }
      return parts.join(" > ");
    };
    const ancestryFor = (element: Element): string[] => {
      const ancestry: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && ancestry.length < 6) {
        const role = current.getAttribute("role");
        const id = current.getAttribute("id");
        const tag = current.tagName.toLowerCase();
        ancestry.unshift(
          `${tag}${role ? `[role=${role}]` : ""}${id ? `#${id}` : ""}`,
        );
        current = current.parentElement;
      }
      return ancestry;
    };
    const nearestText = (
      element: Element,
      selectors: string,
    ): string | undefined => {
      const closest = element.closest(selectors);
      return normalize(closest?.textContent);
    };
    const contextFor = (element: Element) => {
      const landmark = element.closest(
        "main,nav,aside,header,footer,form,article,section,[role='main'],[role='navigation'],[role='dialog'],[role='form'],[role='search'],[role='banner'],[role='contentinfo']",
      );
      const label =
        element.getAttribute("aria-labelledby") &&
        document.getElementById(element.getAttribute("aria-labelledby") || "")
          ?.textContent;
      const parent = element.parentElement;
      const siblingText = normalize(
        [
          parent?.previousElementSibling?.textContent,
          parent?.textContent,
          parent?.nextElementSibling?.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      );
      return {
        landmark: landmark
          ? normalize(
              `${landmark.tagName.toLowerCase()}${landmark.getAttribute("role") ? `[role=${landmark.getAttribute("role")}]` : ""} ${landmark.getAttribute("aria-label") || ""}`,
            )
          : undefined,
        heading: nearestText(element, "h1,h2,h3,h4,h5,h6,[role='heading']"),
        label: normalize(label || element.closest("label")?.textContent),
        nearbyText: siblingText,
      };
    };
    const selectorsFor = (element: Element, role: string, name?: string) => {
      const candidates: Array<{
        selector: string;
        kind: "role" | "css" | "text";
        stability: "strong" | "medium" | "weak";
        reason: string;
      }> = [];
      if (role && name && name.length <= 120) {
        candidates.push({
          selector: `role=${role}[name=${JSON.stringify(name)}]`,
          kind: "role",
          stability: "strong",
          reason: "role and accessible name",
        });
      }
      const id = element.getAttribute("id");
      if (id) {
        candidates.push({
          selector: `${element.tagName.toLowerCase()}#${cssEscape(id)}`,
          kind: "css",
          stability: "strong",
          reason: "element id",
        });
      }
      if (
        element instanceof HTMLAnchorElement &&
        element.getAttribute("href")
      ) {
        candidates.push({
          selector: `a[href=${JSON.stringify(element.getAttribute("href"))}]`,
          kind: "css",
          stability: "medium",
          reason: "anchor href",
        });
      }
      candidates.push({
        selector: cssPath(element),
        kind: "css",
        stability: "weak",
        reason: "structural fallback",
      });
      return candidates;
    };
    const riskHints = (element: Element, name?: string): string[] => {
      const source =
        `${name || ""} ${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
      const hints: string[] = [];
      if (/\b(delete|remove|block|report|unfollow|discard)\b/.test(source))
        hints.push("destructive");
      if (
        /\b(send|submit|post|publish|save|follow|like|compose|connect|invite|accept|endorse|recommend)\b/.test(
          source,
        )
      )
        hints.push("write");
      if (
        element instanceof HTMLAnchorElement &&
        element.getAttribute("href") &&
        element.getAttribute("href") !== "#"
      )
        hints.push("navigation");
      if (
        (element as HTMLElement).isContentEditable ||
        ["INPUT", "TEXTAREA"].includes(element.tagName)
      )
        hints.push("input");
      return hints;
    };
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0
      );
    };
    const rectsOverlap = (a: DOMRect, b: DOMRect): boolean => {
      const xOverlap = Math.max(
        0,
        Math.min(a.right, b.right) - Math.max(a.left, b.left),
      );
      const yOverlap = Math.max(
        0,
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
      );
      const overlapArea = xOverlap * yOverlap;
      const smallerArea = Math.min(a.width * a.height, b.width * b.height);
      return smallerArea > 0 && overlapArea / smallerArea > 0.9;
    };
    const allElementsDeep = (root: ParentNode = document): Element[] => {
      const elements = Array.from(root.querySelectorAll("*"));
      for (const element of [...elements]) {
        const shadowRoot = (element as HTMLElement).shadowRoot;
        if (shadowRoot) elements.push(...allElementsDeep(shadowRoot));
      }
      return elements;
    };
    const rawElements = allElementsDeep().filter((element) => {
      if (element.matches(selector)) return true;
      const style = getComputedStyle(element);
      if (style.cursor !== "pointer") return false;
      const text = normalize(
        element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent,
      );
      return (
        Boolean(text) &&
        !["svg", "path", "use"].includes(element.tagName.toLowerCase())
      );
    });

    const collapsedCounts = new WeakMap<Element, number>();
    const elementSet = new Set(rawElements);
    const keepElements = rawElements.filter((element) => {
      const name = accessibleName(element);
      const href =
        element instanceof HTMLAnchorElement
          ? element.getAttribute("href")
          : undefined;
      let ancestor = element.parentElement;
      while (ancestor) {
        if (elementSet.has(ancestor) && isVisible(ancestor)) {
          const ancestorName = accessibleName(ancestor);
          const ancestorHref =
            ancestor instanceof HTMLAnchorElement
              ? ancestor.getAttribute("href")
              : undefined;
          const sameAction =
            (href && ancestorHref && href === ancestorHref) ||
            (name && ancestorName && name === ancestorName) ||
            rectsOverlap(
              element.getBoundingClientRect(),
              ancestor.getBoundingClientRect(),
            );
          if (sameAction) {
            collapsedCounts.set(
              ancestor,
              (collapsedCounts.get(ancestor) || 0) + 1,
            );
            return false;
          }
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    });

    return keepElements
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = isVisible(element);
        const role = roleFor(element);
        const name = accessibleName(element);
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        return {
          ref: `i${index + 1}`,
          tag: element.tagName.toLowerCase(),
          role,
          actionKind: actionKindFor(element, role),
          name,
          text: normalize(element.textContent),
          href:
            element instanceof HTMLAnchorElement
              ? element.getAttribute("href") || undefined
              : undefined,
          type: element.getAttribute("type") || undefined,
          disabled:
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true",
          visible,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          center: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
          viewport: {
            inViewport:
              rect.bottom >= 0 &&
              rect.right >= 0 &&
              rect.top <= viewportHeight &&
              rect.left <= viewportWidth,
            aboveFold: rect.top >= 0 && rect.top <= viewportHeight,
            viewportWidth,
            viewportHeight,
            scrollX: Math.round(window.scrollX),
            scrollY: Math.round(window.scrollY),
            zIndex:
              style.zIndex && style.zIndex !== "auto"
                ? style.zIndex
                : undefined,
          },
          context: contextFor(element),
          ancestry: ancestryFor(element),
          selectorCandidates: selectorsFor(element, role, name),
          riskHints: riskHints(element, name),
          collapsedFrom: collapsedCounts.get(element) || undefined,
        };
      })
      .filter((control) => control.visible && control.actionKind !== "unknown")
      .map((control, index) => ({ ...control, ref: `i${index + 1}` }));
  });
}

function detectControlGroups(controls: CapturedControl[]): ControlGroup[] {
  const groups: ControlGroup[] = [];
  const nav = controls.filter(
    (control) => control.role === "link" && control.href,
  );
  if (nav.length >= 3) {
    groups.push({
      id: "group-nav",
      kind: "nav_like",
      itemRefs: nav.map((control) => control.ref),
      sharedRole: "link",
      layout: layoutFor(nav),
      sampleNames: nav.slice(0, 6).map(controlLabel),
    });
  }

  const formRefs = controls.filter((control) =>
    ["textbox", "combobox"].includes(control.role),
  );
  if (formRefs.length) {
    groups.push({
      id: "group-form-like",
      kind: "form_like",
      itemRefs: formRefs.map((control) => control.ref),
      layout: layoutFor(formRefs),
      sampleNames: formRefs.slice(0, 6).map(controlLabel),
    });
  }

  const byRole = new Map<string, CapturedControl[]>();
  for (const control of controls) {
    byRole.set(control.role, [...(byRole.get(control.role) || []), control]);
  }
  for (const [role, roleControls] of byRole) {
    if (roleControls.length < 5) continue;
    groups.push({
      id: `group-${slugifyName(role)}-repeated`,
      kind: "repeated_controls",
      itemRefs: roleControls.map((control) => control.ref),
      sharedRole: role,
      selectorShape: roleControls[0]?.selectorCandidates.at(-1)?.selector,
      layout: layoutFor(roleControls),
      sampleNames: roleControls.slice(0, 6).map(controlLabel),
    });
  }
  return groups;
}

function layoutFor(controls: CapturedControl[]): ControlGroup["layout"] {
  if (controls.length < 2) return "clustered";
  const xSpread =
    Math.max(...controls.map((control) => control.center.x)) -
    Math.min(...controls.map((control) => control.center.x));
  const ySpread =
    Math.max(...controls.map((control) => control.center.y)) -
    Math.min(...controls.map((control) => control.center.y));
  if (ySpread > xSpread * 1.5) return "vertical";
  if (xSpread > ySpread * 1.5) return "horizontal";
  return "clustered";
}

function controlLabel(control: CapturedControl): string {
  return control.name || control.text || control.href || control.ref;
}

function captureWarnings(input: {
  controls: CapturedControl[];
  markdownText: string;
}): string[] {
  const warnings: string[] = [];
  if (!input.controls.length)
    warnings.push("no visible interactables captured");
  if (!input.markdownText.trim()) warnings.push("empty markdown capture");
  return warnings;
}
