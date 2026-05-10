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
    const clickIndex = operations.findIndex(
      (operation, candidateIndex) =>
        candidateIndex > index &&
        candidateIndex <= index + 3 &&
        operation.kind === "click",
    );
    if (clickIndex < 0) continue;
    const textIndex = operations.findIndex(
      (operation, candidateIndex) =>
        candidateIndex > clickIndex &&
        candidateIndex <= clickIndex + 2 &&
        operation.kind === "text",
    );
    if (textIndex < 0) continue;
    add(
      "write_and_verify",
      [index, clickIndex, textIndex],
      "fill followed by nearby submit/click and text evidence",
      {
        suggestedCommandName: commandNameFromWrite(
          fill,
          operations[clickIndex],
        ),
        suggestedDescription: descriptionFromWrite(
          fill,
          operations[clickIndex],
        ),
        suggestedArgs: argsForFill(fill),
        suggestedPostconditions: textPostconditions(
          fill,
          operations[textIndex],
        ),
        suggestedStateScope: dmThreadScope(),
        riskFlags: riskFlagsForWrite(fill, operations[clickIndex]),
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
  return (
    operation.kind === "goto" ||
    operation.kind === "click" ||
    operation.kind === "fill"
  );
}

function isStateChanging(operation: FallbackOperation): boolean {
  return operation.kind === "goto" || operation.kind === "click";
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
  clickOperation: FallbackOperation,
): string | undefined {
  const source =
    `${fillOperation.selector || ""} ${clickOperation.selector || ""} ${clickOperation.instruction}`.toLowerCase();
  if (source.includes("send")) return "send_message_in_current_thread";
  return undefined;
}

function descriptionFromWrite(
  fillOperation: FallbackOperation,
  clickOperation: FallbackOperation,
): string | undefined {
  const source =
    `${fillOperation.selector || ""} ${clickOperation.selector || ""} ${clickOperation.instruction}`.toLowerCase();
  if (source.includes("send")) {
    return "Send a message in the currently open Instagram direct-message conversation";
  }
  return undefined;
}

function riskFlagsForWrite(
  fillOperation: FallbackOperation,
  clickOperation: FallbackOperation,
): string[] {
  const flags = ["writes_to_platform"];
  const source = `${fillOperation.urlBefore || ""} ${clickOperation.urlBefore || ""}`;
  if (source.includes("/direct/t/"))
    flags.push("requires_current_thread_context");
  return flags;
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
  return [
    {
      type: "text_contains",
      selector: textOperation.selector || "body",
      value: fillOperation.valuePlaceholder,
    },
  ];
}
