import type {
  AcquisitionCandidate,
  CandidateOperationSlice,
  CommandStateScope,
  EvidenceDigest,
  FallbackOperation,
  FallbackTape,
  OperationDigest,
  Postcondition,
  ProcessArg,
} from "./contracts.js";
import { followerTexts } from "./evidence-digest.js";
import { candidateSlices } from "./slice-candidates.js";

export function operationDigest(tape: FallbackTape): OperationDigest {
  const operations = tape.operations || [];
  return {
    operationCount: operations.length,
    executableCount: operations.filter(isExecutable).length,
    writeCount: operations.filter((operation) => operation.writesToPlatform)
      .length,
    snapshotCount: operations.filter(
      (operation) => operation.kind === "snapshot",
    ).length,
    weakSelectorCount: operations.filter(hasWeakSelector).length,
    urlsVisited: unique(
      operations.flatMap((operation) =>
        [operation.urlBefore, operation.urlAfter].filter((url): url is string =>
          Boolean(url),
        ),
      ),
    ),
  };
}

export function acquisitionCandidates(input: {
  tape: FallbackTape;
  evidenceDigest: EvidenceDigest;
}): AcquisitionCandidate[] {
  const candidates: AcquisitionCandidate[] = [];
  const add = (candidate: Omit<AcquisitionCandidate, "reviewItemId">) => {
    candidates.push({
      ...candidate,
      reviewItemId: `${candidate.fallbackTapeId}:${candidate.id}`,
    });
  };

  for (const slice of candidateSlices(input.tape)) {
    add(fromOperationSlice(input.tape, slice));
  }

  for (const candidate of readProfileSummaryCandidates(input)) add(candidate);
  for (const candidate of searchProfilesCandidates(input)) add(candidate);
  for (const candidate of writeCommandCandidates(input)) add(candidate);

  return dedupeCandidates(candidates);
}

function fromOperationSlice(
  tape: FallbackTape,
  slice: CandidateOperationSlice,
): Omit<AcquisitionCandidate, "reviewItemId"> {
  const kind =
    slice.kind === "write_and_verify"
      ? "write_command"
      : slice.kind === "open_and_read" || slice.kind === "read"
        ? "read_output"
        : slice.kind === "misc"
          ? "remainder"
          : slice.kind === "primitive"
            ? "remainder"
            : slice.kind;
  return {
    id: `op-${slice.id}`,
    fallbackTapeId: tape.id,
    kind,
    operationIndexes: slice.operationIndexes,
    evidencePaths: evidencePathsForIndexes(
      tape.operations || [],
      slice.operationIndexes,
    ),
    deterministicReason: slice.mechanicalReason,
    suggestedCommandName: slice.suggestedCommandName,
    suggestedDescription: slice.suggestedDescription,
    suggestedArgs: slice.suggestedArgs,
    suggestedOutputs: slice.suggestedOutputs,
    suggestedValueBindings: slice.suggestedValueBindings,
    suggestedPostconditions: slice.suggestedPostconditions,
    suggestedStateScope: slice.suggestedStateScope,
    riskFlags: slice.riskFlags || [],
    harnessEasyToPromote: easyRankForSlice(slice),
    agentMustRate: true,
  };
}

function readProfileSummaryCandidates(input: {
  tape: FallbackTape;
  evidenceDigest: EvidenceDigest;
}): Array<Omit<AcquisitionCandidate, "reviewItemId">> {
  const profileSignals = input.evidenceDigest.pageKinds.filter(
    (signal) => signal.kind === "instagram_profile",
  );
  const followerEvidence = input.evidenceDigest.repeatedTextPatterns.find(
    (pattern) => pattern.name === "follower_count_text",
  );
  if (!profileSignals.length || !followerEvidence) return [];

  const operationIndexes = uniqueNumbers(
    profileSignals
    .map((signal) =>
      operationIndexForEvidence(
        input.tape.operations || [],
        signal.evidencePath,
      ),
    )
      .filter((index): index is number => index !== undefined),
  );
  const representativeOperationIndex = operationIndexes[0];
  if (representativeOperationIndex === undefined) return [];

  const args: ProcessArg[] = [
    {
      name: "username",
      required: true,
      description: "Instagram username without @",
    },
  ];
  const postconditions: Postcondition[] = [
    { type: "url_contains", value: "/%username%/" },
    { type: "text_contains", selector: "main", value: "followers" },
  ];

  return [
    {
      id: "read-profile-summary",
      fallbackTapeId: input.tape.id,
      kind: "read_output",
      operationIndexes: [representativeOperationIndex],
      evidencePaths: unique(followerEvidence.evidencePaths),
      deterministicReason:
        "profile-shaped snapshots contain follower-count text; promote one representative profile navigation plus body text outputs",
      suggestedCommandName: "read_profile_summary_by_username",
      suggestedDescription:
        "Open an Instagram profile by username and return visible profile summary text",
      suggestedArgs: args,
      suggestedValueBindings: [
        {
          operationIndex: representativeOperationIndex,
          argName: "username",
          target: "selector",
        },
      ],
      suggestedOutputs: [
        {
          name: "profileText",
          source: "text",
          selector: "main",
          description:
            "Visible profile header text including username, bio, posts, followers, and following counts",
        },
        {
          name: "followersText",
          source: "text",
          selector: "main",
          description: "Visible follower-count text from the profile header",
        },
      ],
      suggestedPostconditions: postconditions,
      riskFlags: ["profile_main_output"],
      harnessEasyToPromote:
        followerEvidence.count >= 2 && profileSignals.length >= 2
          ? "high"
          : "medium",
      agentMustRate: true,
    },
  ];
}

function searchProfilesCandidates(input: {
  tape: FallbackTape;
  evidenceDigest: EvidenceDigest;
}): Array<Omit<AcquisitionCandidate, "reviewItemId">> {
  const searchSignals = input.evidenceDigest.pageKinds.filter(
    (signal) => signal.kind === "instagram_search_results",
  );
  if (!searchSignals.length) return [];
  const followerRows = input.evidenceDigest.observedLinks.filter(
    (link) => followerTexts(link.text).length,
  );
  if (!followerRows.length) return [];
  return [
    {
      id: "search-profiles-by-query",
      fallbackTapeId: input.tape.id,
      kind: "read_output",
      operationIndexes: uniqueNumbers(
        searchSignals
          .map((signal) =>
            operationIndexForEvidence(
              input.tape.operations || [],
              signal.evidencePath,
            ),
          )
          .filter((index): index is number => index !== undefined),
      ),
      evidencePaths: unique(followerRows.map((row) => row.evidencePath)),
      deterministicReason:
        "search-result snapshots expose profile rows with follower text",
      suggestedCommandName: "search_profiles_by_query",
      suggestedDescription:
        "Open Instagram search results for a query and return visible profile result rows",
      suggestedArgs: [
        { name: "query", required: true, description: "Search query" },
      ],
      suggestedOutputs: [
        {
          name: "resultRowsText",
          source: "text",
          selector: "body",
          description:
            "Visible search result rows including usernames and follower text",
        },
      ],
      suggestedPostconditions: [
        { type: "url_contains", value: "/explore/search/" },
      ],
      riskFlags: ["search_results_dynamic", "body_selector_output"],
      harnessEasyToPromote: "medium",
      agentMustRate: true,
    },
  ];
}

function writeCommandCandidates(input: {
  tape: FallbackTape;
  evidenceDigest: EvidenceDigest;
}): Array<Omit<AcquisitionCandidate, "reviewItemId">> {
  const operations = input.tape.operations || [];
  const candidates: Array<Omit<AcquisitionCandidate, "reviewItemId">> = [];
  for (const [index, operation] of operations.entries()) {
    if (operation.kind !== "fill") continue;
    const nearbySubmitIndex = operations.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        candidateIndex <= index + 3 &&
        isSubmitOperation(candidate),
    );
    if (nearbySubmitIndex < 0) continue;
    const nearbySubmit = operations[nearbySubmitIndex];
    const threadUrls = [
      operation.urlBefore,
      operation.urlAfter,
      nearbySubmit.urlBefore,
      nearbySubmit.urlAfter,
    ].filter(Boolean);
    const inDirectThread = threadUrls.some((url) => url?.includes("/direct/t/"));
    const inComposerModal = isSendSubmitOperation(nearbySubmit);
    if (!inDirectThread && !inComposerModal) continue;
    const weak =
      hasWeakSelector(operation) ||
      hasWeakSelector(nearbySubmit) ||
      operation.writeGrounding?.promotionReady === false ||
      nearbySubmit.writeGrounding?.promotionReady === false;
    const suggestedPostconditions =
      renderedSendPostconditions(operation, nearbySubmit) ||
      operation.writeGrounding?.postconditionHints ||
      nearbySubmit.writeGrounding?.postconditionHints ||
      [];
    candidates.push({
      id: "send-message-current-thread",
      fallbackTapeId: input.tape.id,
      kind: weak ? "repair" : "write_command",
      operationIndexes: [index, nearbySubmitIndex],
      evidencePaths: evidencePathsForIndexes(operations, [
        index,
        nearbySubmitIndex,
      ]),
      deterministicReason: weak
        ? "DM composer fill and submit succeeded but used weak selectors; reacquire with durable composer selectors before promotion"
        : "DM composer fill followed by nearby submit in a direct thread",
      suggestedCommandName: "send_message_current_thread",
      suggestedDescription:
        "Send a message in the currently open Instagram direct-message thread",
      suggestedArgs: [
        {
          name: "message",
          required: true,
          description: "Message text to send",
        },
      ],
      suggestedValueBindings: [
        { operationIndex: index, argName: "message", target: "argument" },
      ],
      suggestedPostconditions,
      suggestedStateScope: inDirectThread
        ? dmThreadScope()
        : composerModalScope(nearbySubmit),
      riskFlags: weak
        ? [
            "writes_to_platform",
            "weak_write_selectors",
            "rerecord_recommended",
            inDirectThread
              ? "requires_current_thread_context"
              : "requires_current_composer_context",
          ]
        : [
            "writes_to_platform",
            inDirectThread
              ? "requires_current_thread_context"
              : "requires_current_composer_context",
          ],
      harnessEasyToPromote: weak ? "low" : "medium",
      agentMustRate: true,
    });
  }
  return candidates;
}

function dmThreadScope(): CommandStateScope {
  return {
    preconditions: [{ type: "url_contains", value: "/direct/t/" }],
    onUnmetPrecondition: "fallback",
  };
}

function composerModalScope(submitOperation: FallbackOperation): CommandStateScope {
  return {
    preconditions: [
      {
        type: "selector_exists",
        selector: durableSubmitSelector(submitOperation) || "role=button[name=\"Send\"]",
      },
    ],
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

function renderedSendPostconditions(
  fillOperation: FallbackOperation,
  submitOperation: FallbackOperation,
): Postcondition[] | undefined {
  const urls = [
    fillOperation.urlBefore,
    fillOperation.urlAfter,
    submitOperation.urlBefore,
    submitOperation.urlAfter,
  ];
  if (!urls.some((url) => url?.includes("/direct/t/"))) return undefined;
  return [
    { type: "url_contains", value: "/direct/t/" },
    {
      type: "rendered_text_contains",
      selector: "main",
      value: "%message%",
      excludeSelectors: [
        "[contenteditable='true']",
        "textarea",
        "input",
        "[role='textbox']",
      ],
    },
  ];
}

function isSubmitOperation(operation: FallbackOperation): boolean {
  if (operation.kind === "press") {
    return (
      (operation.commandArgs?.[0] || operation.selector || "")
        .trim()
        .toLowerCase() === "enter"
    );
  }
  if (operation.kind === "click" || operation.kind === "dblclick") {
    return isSendSubmitOperation(operation);
  }
  return false;
}

function isSendSubmitOperation(operation: FallbackOperation): boolean {
  const source =
    `${operation.selector || ""} ${operation.instruction || ""} ${operation.evidenceSummary?.target?.name || ""}`.toLowerCase();
  return /\b(send|submit|post|publish|save|confirm)\b/.test(source);
}

function durableSubmitSelector(operation: FallbackOperation): string | undefined {
  if (
    operation.selector &&
    !operation.selector.match(/^(?:aria-ref=)?[a-z]?\d+$/i)
  ) {
    return operation.selector;
  }
  return operation.selectorCandidates?.find(
    (candidate) => candidate.stability !== "weak",
  )?.selector;
}


function easyRankForSlice(
  slice: CandidateOperationSlice,
): "low" | "medium" | "high" {
  if (slice.riskFlags?.some((flag) => flag.includes("write"))) return "low";
  if (slice.suggestedCommandName && slice.suggestedPostconditions?.length) {
    return slice.suggestedOutputs?.length ? "high" : "medium";
  }
  return "low";
}

function evidencePathsForIndexes(
  operations: FallbackOperation[],
  indexes: number[],
): string[] {
  return unique(
    indexes.flatMap((index) => {
      const operation = operations[index];
      if (!operation) return [];
      return [
        operation.evidencePath,
        operation.evidenceSummaryPath,
        ...Object.values(operation.evidencePaths || {}),
      ].filter((path): path is string => Boolean(path));
    }),
  );
}

function operationIndexForEvidence(
  operations: FallbackOperation[],
  evidencePath?: string,
): number | undefined {
  if (!evidencePath) return undefined;
  const index = operations.findIndex((operation) =>
    [
      operation.evidencePath,
      operation.evidenceSummaryPath,
      ...Object.values(operation.evidencePaths || {}),
    ].includes(evidencePath),
  );
  return index >= 0 ? index : undefined;
}

function dedupeCandidates(
  candidates: AcquisitionCandidate[],
): AcquisitionCandidate[] {
  const seen = new Set<string>();
  const out: AcquisitionCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.suggestedCommandName || candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
