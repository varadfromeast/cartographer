import type {
  CandidateOperationSlice,
  CommandStateScope,
  FallbackOperation,
  FallbackTape,
  Postcondition,
} from "./contracts.js";

export function candidateSlices(tape: FallbackTape): CandidateOperationSlice[] {
  const operations = tape.operations || [];
  const slices: CandidateOperationSlice[] = [];
  const add = (
    kind: CandidateOperationSlice["kind"],
    operationIndexes: number[],
    mechanicalReason: string,
    suggestions: Partial<CandidateOperationSlice> = {},
  ) => {
    if (!operationIndexes.length) return;
    const id = `${kind}-${String(slices.length + 1).padStart(2, "0")}`;
    slices.push({
      id,
      reviewItemId: `${tape.id}:${id}`,
      kind,
      fallbackTapeId: tape.id,
      operationIndexes,
      mechanicalReason,
      ...suggestions,
    });
  };

  const suggestedNavigationCommands = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "goto") {
      const suggestion = navigationSuggestion(
        operation.selector || operation.urlAfter,
        index,
      );
      if (
        suggestion.suggestedCommandName &&
        suggestedNavigationCommands.has(suggestion.suggestedCommandName)
      ) {
        continue;
      }
      if (suggestion.suggestedCommandName) {
        suggestedNavigationCommands.add(suggestion.suggestedCommandName);
      }
      add("navigation", [index], "direct URL navigation", {
        ...suggestion,
      });
    }
  }

  for (const [index, operation] of operations.entries()) {
    if (
      operation.kind === "click" &&
      !operation.urlBefore?.includes("/direct/inbox") &&
      operation.urlAfter?.includes("/direct/inbox")
    ) {
      add(
        "state_transition",
        [index],
        "click opened Instagram direct messages inbox",
        {
          suggestedCommandName: "open_inbox",
          suggestedDescription: "Open Instagram direct messages inbox",
          suggestedPostconditions: [
            { type: "url_contains", value: "/direct/inbox" },
          ],
        },
      );
    }
    if (
      operation.kind === "click" &&
      operation.urlBefore?.includes("/direct/inbox") &&
      operation.urlAfter?.includes("/direct/t/") &&
      quotedSelectorValue(operation.selector) &&
      !isGenericComposeTransition(operation.selector) &&
      !hasPriorInboxSearchFill(operations, index) &&
      !operation.evidenceSummary?.warnings.includes(
        "target_name_contains_transient_text",
      )
    ) {
      add(
        "state_transition",
        [index],
        "inbox thread row click opened a direct-message thread",
        {
          suggestedCommandName: "open_thread_by_name",
          suggestedDescription:
            "Open an Instagram direct-message thread from the inbox by visible thread name",
          suggestedArgs: [
            {
              name: "threadName",
              required: true,
              description: "visible thread name in the inbox",
            },
          ],
          suggestedValueBindings: [
            {
              operationIndex: index,
              argName: "threadName",
              target: "selector",
            },
          ],
          suggestedPostconditions: [
            { type: "url_contains", value: "/direct/t/" },
          ],
          suggestedStateScope: inboxScope(),
        },
      );
    }
  }

  for (let index = 0; index < operations.length - 1; index += 1) {
    const searchAndOpenThread = inboxSearchThenThreadOpen(
      operations,
      index,
    );
    if (searchAndOpenThread) {
      add(
        "state_transition",
        searchAndOpenThread.operationIndexes,
        "inbox search followed by matching direct-message thread result click",
        {
          suggestedCommandName: "open_thread_by_name",
          suggestedDescription:
            "Search the Instagram inbox and open a direct-message thread by visible thread name",
          suggestedArgs: [
            {
              name: "threadName",
              required: true,
              description: "visible thread name or handle in the inbox",
            },
          ],
          suggestedValueBindings: [
            {
              operationIndex: searchAndOpenThread.fillIndex,
              argName: "threadName",
              target: "argument",
            },
            {
              operationIndex: searchAndOpenThread.clickIndex,
              argName: "threadName",
              target: "selector",
            },
          ],
          suggestedPostconditions: [
            { type: "url_contains", value: "/direct/t/" },
          ],
          suggestedStateScope: inboxScope(),
          riskFlags: searchAndOpenThread.weak
            ? ["weak_search_selector", "rerecord_recommended"]
            : [],
        },
      );
    }
    if (
      isStateChanging(operations[index]) &&
      operations[index + 1].kind === "text"
    ) {
      add(
        "open_and_read",
        [index, index + 1],
        "state-changing operation followed by text evidence",
        {
          suggestedOutputs: [
            {
              name: "visibleText",
              source: "text",
              selector: operations[index + 1].selector || "body",
              description: "visible text after the state transition",
            },
          ],
        },
      );
    }
  }

  for (let index = 0; index < operations.length; index += 1) {
    const fill = operations[index];
    if (fill.kind !== "fill") continue;
    const submitIndex = operations.findIndex(
      (operation, candidateIndex) =>
        candidateIndex > index &&
        candidateIndex <= index + 3 &&
        isSubmitOperation(operation),
    );
    if (submitIndex < 0) continue;
    const textIndex = operations.findIndex(
      (operation, candidateIndex) =>
        candidateIndex > submitIndex &&
        candidateIndex <= submitIndex + 2 &&
        operation.kind === "text",
    );
    if (textIndex < 0) continue;
    add(
      "write_and_verify",
      [index, submitIndex, textIndex],
      "fill followed by nearby submit/click and text evidence",
      {
        suggestedCommandName: commandNameFromWrite(
          fill,
          operations[submitIndex],
        ),
        suggestedDescription: descriptionFromWrite(
          fill,
          operations[submitIndex],
        ),
        suggestedArgs: argsForFill(fill),
        suggestedPostconditions: textPostconditions(
          fill,
          operations[textIndex],
        ),
        suggestedStateScope: dmThreadScope(),
        riskFlags: riskFlagsForWrite(fill, operations[submitIndex]),
      },
    );
  }

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "text") {
      add("read", [index], "text evidence read", {
        suggestedOutputs: [
          {
            name: "visibleText",
            source: "text",
            selector: operation.selector || "body",
            description: "visible text",
          },
        ],
      });
    }
    if (isExecutable(operation)) {
      add(
        "primitive",
        [index],
        `single executable ${operation.kind} operation`,
      );
    }
  }

  const executableIndexes = operations
    .map((operation, index) => (isExecutable(operation) ? index : -1))
    .filter((index) => index >= 0);
  add(
    "misc",
    executableIndexes,
    "all executable operations; use only if no specific candidate slice fits",
    { riskFlags: tape.writesToPlatform ? ["writes_to_platform"] : [] },
  );

  return slices;
}

function inboxScope(): CommandStateScope {
  return {
    preconditions: [{ type: "url_contains", value: "/direct/inbox" }],
    autoEnterProcessName: "open_inbox",
    onUnmetPrecondition: "fallback",
  };
}

function dmThreadScope(): CommandStateScope {
  return {
    preconditions: [{ type: "url_contains", value: "/direct/t/" }],
    onUnmetPrecondition: "fallback",
  };
}

function isExecutable(operation: FallbackOperation): boolean {
  return executableOperationKinds.has(operation.kind);
}

const executableOperationKinds = new Set<FallbackOperation["kind"]>([
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

function isStateChanging(operation: FallbackOperation): boolean {
  return operation.kind === "goto" || operation.kind === "click";
}

function inboxSearchThenThreadOpen(
  operations: FallbackOperation[],
  index: number,
):
  | {
      fillIndex: number;
      clickIndex: number;
      operationIndexes: number[];
      weak: boolean;
    }
  | undefined {
  const fill = operations[index];
  if (fill.kind !== "fill" || !fill.urlBefore?.includes("/direct/inbox")) {
    return undefined;
  }
  const selectorSource = `${fill.selector || ""} ${fill.instruction}`.toLowerCase();
  if (!/\bsearch\b/.test(selectorSource)) return undefined;
  const clickIndex = operations.findIndex(
    (operation, candidateIndex) =>
      candidateIndex > index &&
      candidateIndex <= index + 4 &&
      operation.kind === "click" &&
      operation.urlBefore?.includes("/direct/inbox") &&
      operation.urlAfter?.includes("/direct/t/"),
  );
  if (clickIndex < 0) return undefined;
  const click = operations[clickIndex];
  return {
    fillIndex: index,
    clickIndex,
    operationIndexes: [index, clickIndex],
    weak:
      hasWeakSelector(fill) ||
      hasWeakSelector(click) ||
      fill.writeGrounding?.promotionReady === false,
  };
}

function hasPriorInboxSearchFill(
  operations: FallbackOperation[],
  clickIndex: number,
): boolean {
  const click = operations[clickIndex];
  if (
    click.kind !== "click" ||
    !click.urlBefore?.includes("/direct/inbox") ||
    !click.urlAfter?.includes("/direct/t/")
  ) {
    return false;
  }
  return operations.some(
    (operation, index) =>
      index < clickIndex &&
      index >= clickIndex - 4 &&
      operation.kind === "fill" &&
      operation.urlBefore?.includes("/direct/inbox") &&
      /\bsearch\b/.test(
        `${operation.selector || ""} ${operation.instruction}`.toLowerCase(),
      ),
  );
}

function hasWeakSelector(operation: FallbackOperation): boolean {
  const selectedCandidate = operation.selectorCandidates?.find(
    (candidate) => candidate.selector === operation.selector,
  );
  return Boolean(
    operation.selector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i) ||
      selectedCandidate?.stability === "weak" ||
      operation.evidenceSummary?.warnings?.some((warning) =>
        /raw_snapshot_ref|weak|no_durable/.test(warning),
      ) ||
      operation.writeGrounding?.promotionReady === false,
  );
}

function navigationSuggestion(
  url: string | undefined,
  operationIndex: number,
): Partial<CandidateOperationSlice> {
  if (!url) return {};
  const parsed = parseInstagramUrl(url);
  if (!parsed) return { riskFlags: ["external_or_unparseable_url"] };
  if (parsed.pathname === "/direct/inbox/") {
    return {
      suggestedCommandName: "open_inbox",
      suggestedDescription: "Open Instagram direct messages inbox",
      suggestedPostconditions: [
        { type: "url_contains", value: "/direct/inbox" },
      ],
    };
  }
  if (parsed.pathname === "/explore/") {
    return {
      suggestedCommandName: "open_explore",
      suggestedDescription: "Open Instagram Explore page",
      suggestedPostconditions: [{ type: "url_contains", value: "/explore" }],
    };
  }
  if (parsed.pathname.startsWith("/direct/t/")) {
    return { riskFlags: ["private_direct_thread_url"] };
  }
  const username = profileUsernameFromPath(parsed.pathname);
  if (username) {
    return {
      suggestedCommandName: "open_profile_by_username",
      suggestedDescription: "Open an Instagram profile by username",
      suggestedArgs: [
        {
          name: "username",
          required: true,
          description: "Instagram username without @",
        },
      ],
      suggestedValueBindings: [
        {
          operationIndex,
          argName: "username",
          target: "selector",
        },
      ],
      suggestedPostconditions: [
        { type: "url_contains", value: "/%username%/" },
      ],
    };
  }
  return { riskFlags: ["literal_url_not_generic"] };
}

function parseInstagramUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.instagram.com" ||
      parsed.hostname === "instagram.com"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function profileUsernameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (!match) return null;
  const username = match[1];
  if (
    ["accounts", "direct", "explore", "p", "reel", "stories", "about"].includes(
      username,
    )
  ) {
    return null;
  }
  return username;
}

function quotedSelectorValue(selector?: string): string | undefined {
  if (!selector) return undefined;
  return selector.match(/"([^"]+)"/)?.[1] || selector.match(/'([^']+)'/)?.[1];
}

function isGenericComposeTransition(selector?: string): boolean {
  const value = quotedSelectorValue(selector)?.trim().toLowerCase();
  return value === "chat" || value === "new message" || value === "next";
}

function commandNameFromWrite(
  fillOperation: FallbackOperation,
  submitOperation: FallbackOperation,
): string | undefined {
  const source =
    `${fillOperation.selector || ""} ${submitOperation.selector || ""} ${submitOperation.instruction}`.toLowerCase();
  if (source.includes("send") || isEnterPress(submitOperation)) {
    return "send_message_current_thread";
  }
  return undefined;
}

function descriptionFromWrite(
  fillOperation: FallbackOperation,
  submitOperation: FallbackOperation,
): string | undefined {
  const source =
    `${fillOperation.selector || ""} ${submitOperation.selector || ""} ${submitOperation.instruction}`.toLowerCase();
  if (source.includes("send") || isEnterPress(submitOperation)) {
    return "Send a message in the currently open Instagram direct-message conversation";
  }
  return undefined;
}

function riskFlagsForWrite(
  fillOperation: FallbackOperation,
  submitOperation: FallbackOperation,
): string[] {
  const flags = ["writes_to_platform"];
  const source = `${fillOperation.urlBefore || ""} ${submitOperation.urlBefore || ""}`;
  if (source.includes("/direct/t/"))
    flags.push("requires_current_thread_context");
  if (
    fillOperation.writeGrounding?.promotionReady === false ||
    submitOperation.writeGrounding?.promotionReady === false ||
    fillOperation.selector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i) ||
    submitOperation.selector?.match(/^(?:aria-ref=)?[a-z]?\d+$/i)
  ) {
    flags.push("weak_write_selectors", "rerecord_recommended");
  }
  return flags;
}

function isSubmitOperation(operation: FallbackOperation): boolean {
  if (operation.kind === "press") return isEnterPress(operation);
  if (operation.kind === "click" || operation.kind === "dblclick") {
    const source =
      `${operation.selector || ""} ${operation.instruction || ""}`.toLowerCase();
    return /\b(send|submit|post|publish|save|confirm)\b/.test(source);
  }
  return false;
}

function isEnterPress(operation: FallbackOperation): boolean {
  return (
    operation.kind === "press" &&
    (operation.commandArgs?.[0] || operation.selector || "")
      .trim()
      .toLowerCase() === "enter"
  );
}

function argsForFill(
  operation: FallbackOperation,
): CandidateOperationSlice["suggestedArgs"] {
  const argName = operation.valuePlaceholder?.match(/^%(.+)%$/)?.[1];
  if (!argName) return undefined;
  return [
    { name: argName, required: true, description: `${argName} argument` },
  ];
}

function textPostconditions(
  fillOperation: FallbackOperation,
  textOperation: FallbackOperation,
): Postcondition[] | undefined {
  if (!fillOperation.valuePlaceholder) return undefined;
  if (fillOperation.urlAfter?.includes("/direct/t/")) {
    return [
      { type: "url_contains", value: "/direct/t/" },
      {
        type: "rendered_text_contains",
        selector: "main",
        value: fillOperation.valuePlaceholder,
        excludeSelectors: [
          "[contenteditable='true']",
          "textarea",
          "input",
          "[role='textbox']",
        ],
      },
    ];
  }
  return [
    {
      type: "text_contains",
      selector: textOperation.selector || "body",
      value: fillOperation.valuePlaceholder,
    },
  ];
}
