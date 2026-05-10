type LocatorLike = {
  first(): LocatorLike;
  count(): Promise<number>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press?(key: string): Promise<void>;
  innerText(options?: { timeout?: number }): Promise<string>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  scrollIntoViewIfNeeded(): Promise<void>;
  evaluateAll<T, Arg>(
    pageFunction: (elements: Element[], arg: Arg) => T,
    arg: Arg,
  ): Promise<T>;
  elementHandle?(options?: { timeout?: number }): Promise<{
    evaluate<T>(pageFunction: (element: Element) => T): Promise<T>;
  } | null>;
};

type PageLike = {
  locator(selector: string): LocatorLike;
  getByRole?(
    role: string,
    options?: { name?: string; exact?: boolean },
  ): LocatorLike;
  getByText?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByLabel?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByTestId?(testId: string): LocatorLike;
  getByTitle?(text: string, options?: { exact?: boolean }): LocatorLike;
  getByAltText?(text: string, options?: { exact?: boolean }): LocatorLike;
};

export type SelectorKind = "xpath" | "css" | "url" | "playwright" | "unknown";

type ParsedPlaywrightSelector =
  | { kind: "ariaRef"; value: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "text"; value: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "testid"; value: string }
  | { kind: "title"; value: string }
  | { kind: "alt"; value: string };

export function classifySelector(selector: string): SelectorKind {
  if (selector.startsWith("http://") || selector.startsWith("https://"))
    return "url";
  if (isPlaywrightLocatorSelector(selector)) return "playwright";
  if (selector.startsWith("xpath=") || selector.startsWith("/")) return "xpath";
  if (selector.trim()) return "css";
  return "unknown";
}

export function isPlaywrightLocatorSelector(selector: string): boolean {
  return parsePlaywrightSelector(selector) !== null;
}

export function playwrightLocatorCodeForSelector(selector: string): string {
  const parsed = parsePlaywrightSelector(selector);
  if (!parsed) return `page.locator(${JSON.stringify(selector)})`;

  if (parsed.kind === "ariaRef")
    return `page.locator(${JSON.stringify(`aria-ref=${parsed.value}`)})`;
  if (parsed.kind === "role") {
    return parsed.name
      ? `page.getByRole(${JSON.stringify(parsed.role)}, { name: ${JSON.stringify(parsed.name)}, exact: true })`
      : `page.getByRole(${JSON.stringify(parsed.role)})`;
  }
  if (parsed.kind === "text")
    return `page.getByText(${JSON.stringify(parsed.value)}, { exact: true })`;
  if (parsed.kind === "label")
    return `page.getByLabel(${JSON.stringify(parsed.value)}, { exact: true })`;
  if (parsed.kind === "placeholder")
    return `page.getByPlaceholder(${JSON.stringify(parsed.value)}, { exact: true })`;
  if (parsed.kind === "testid")
    return `page.getByTestId(${JSON.stringify(parsed.value)})`;
  if (parsed.kind === "title")
    return `page.getByTitle(${JSON.stringify(parsed.value)}, { exact: true })`;
  if (parsed.kind === "alt")
    return `page.getByAltText(${JSON.stringify(parsed.value)}, { exact: true })`;
  return `page.locator(${JSON.stringify(selector)})`;
}

export function locatorForSelector(
  page: PageLike | LocatorLike,
  selector: string,
): LocatorLike {
  const parts = selector.split(">>").map((p) => p.trim());
  let current: PageLike | LocatorLike = page;

  for (const part of parts) {
    const parsed = parsePlaywrightSelector(part);
    if (!parsed) {
      current = (current as any).locator(part);
      continue;
    }

    if (parsed.kind === "ariaRef") {
      current = (current as any).locator(`aria-ref=${parsed.value}`);
    } else if (parsed.kind === "role") {
      if (!(current as any).getByRole) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByRole(parsed.role, {
          name: parsed.name,
          exact: parsed.name ? true : undefined,
        });
      }
    } else if (parsed.kind === "text") {
      if (!(current as any).getByText) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByText(parsed.value, { exact: true });
      }
    } else if (parsed.kind === "label") {
      if (!(current as any).getByLabel) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByLabel(parsed.value, { exact: true });
      }
    } else if (parsed.kind === "placeholder") {
      if (!(current as any).getByPlaceholder) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByPlaceholder(parsed.value, {
          exact: true,
        });
      }
    } else if (parsed.kind === "testid") {
      if (!(current as any).getByTestId) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByTestId(parsed.value);
      }
    } else if (parsed.kind === "title") {
      if (!(current as any).getByTitle) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByTitle(parsed.value, { exact: true });
      }
    } else if (parsed.kind === "alt") {
      if (!(current as any).getByAltText) {
        current = (current as any).locator(part);
      } else {
        current = (current as any).getByAltText(parsed.value, { exact: true });
      }
    } else {
      current = (current as any).locator(part);
    }
  }

  return current as LocatorLike;
}

function parsePlaywrightSelector(
  selector: string,
): ParsedPlaywrightSelector | null {
  const trimmed = selector.trim();

  const ariaRef = trimmed.match(/^(?:aria-ref=)?([a-z]?\d+)$/i);
  if (ariaRef) {
    return { kind: "ariaRef", value: ariaRef[1] };
  }

  const roleMatch = trimmed.match(
    /^role=([a-zA-Z][a-zA-Z0-9_-]*)(?:\[name=(.+)\])?$/,
  );
  if (roleMatch) {
    return {
      kind: "role",
      role: roleMatch[1],
      name: roleMatch[2] ? parseSelectorValue(roleMatch[2]) : undefined,
    };
  }

  for (const kind of [
    "text",
    "label",
    "placeholder",
    "testid",
    "title",
    "alt",
  ] as const) {
    const prefix = `${kind}=`;
    if (!trimmed.startsWith(prefix)) continue;
    return {
      kind,
      value: parseSelectorValue(trimmed.slice(prefix.length)),
    };
  }

  return null;
}

function parseSelectorValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(
        trimmed.startsWith("'")
          ? JSON.stringify(trimmed.slice(1, -1))
          : trimmed,
      );
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
