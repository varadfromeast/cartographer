import type {
  Action,
  FallbackOperation,
  FallbackTape,
  OperationValueBinding,
  ProcessArg,
  State,
  TapeStep,
} from "./contracts.js";
import { sha256 } from "./hash.js";
import { shapeUrl } from "./state-identity.js";

export function createOperationSliceTape(
  tape: FallbackTape,
  operationIndexes: number[],
  options: {
    args?: ProcessArg[];
    valueBindings?: OperationValueBinding[];
  } = {},
): FallbackTape {
  const operations = tape.operations || [];
  const uniqueIndexes = [...new Set(operationIndexes)];
  if (!uniqueIndexes.length) {
    throw new Error(
      "Promote decisions with operationIndexes need at least one operation.",
    );
  }
  const selected = uniqueIndexes.map((operationIndex) => {
    const operation = operations[operationIndex];
    if (!operation) {
      throw new Error(`Unknown fallback operation index: ${operationIndex}`);
    }
    return { operationIndex, operation };
  });
  const executable = selected.filter(({ operation }) =>
    isExecutableOperation(operation),
  );
  if (!executable.length) {
    throw new Error(
      "Operation slice needs at least one executable operation.",
    );
  }

  const argumentBindings = new Map(
    (options.valueBindings || [])
      .filter((binding) => !binding.target || binding.target === "argument")
      .map((binding) => [binding.operationIndex, binding.argName]),
  );
  const selectorBindings = new Map(
    (options.valueBindings || [])
      .filter((binding) => binding.target === "selector")
      .map((binding) => [binding.operationIndex, binding.argName]),
  );
  const now = new Date().toISOString();
  const syntheticSteps = executable.map(
    ({ operationIndex, operation }, index) =>
      operationToStep({
        tape,
        operation,
        operationIndex,
        stepIndex: index,
        now,
        argName: argumentBindings.get(operationIndex),
        selectorArgName: selectorBindings.get(operationIndex),
        writesToPlatform: operationWritesToPlatform(operation),
      }),
  );
  const args = argsForSlice(
    executable,
    options.args || [],
    argumentBindings,
    selectorBindings,
  );

  return {
    ...tape,
    id: sha256({
      sourceFallbackTapeId: tape.id,
      operationIndexes: uniqueIndexes,
      kind: "operation_slice",
    }),
    sourceFallbackTapeId: tape.sourceFallbackTapeId || tape.id,
    sourceOperationIndexes: uniqueIndexes,
    steps: syntheticSteps,
    args,
    writesToPlatform: syntheticSteps.some((step) => step.writesToPlatform),
  };
}

function isExecutableOperation(operation: FallbackOperation): boolean {
  return executableOperationKinds.has(operation.kind);
}

const executableOperationKinds = new Set<FallbackOperation["kind"]>([
  "goto",
  "snapshot",
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

function operationWritesToPlatform(operation: FallbackOperation): boolean {
  if (operation.writesToPlatform) return true;
  if (operation.kind !== "click") return false;
  const source =
    `${operation.instruction} ${operation.selector || ""}`.toLowerCase();
  return /\b(send|submit|post|publish|save|confirm|delete|remove)\b/.test(
    source,
  );
}

function operationToStep(input: {
  tape: FallbackTape;
  operation: FallbackOperation;
  operationIndex: number;
  stepIndex: number;
  now: string;
  argName?: string;
  selectorArgName?: string;
  writesToPlatform: boolean;
}): TapeStep {
  const before = syntheticState(
    input.tape,
    input.operation.urlBefore || input.tape.entry.url,
    `op-${input.operationIndex}-before`,
  );
  const after = syntheticState(
    input.tape,
    input.operation.urlAfter ||
      input.operation.urlBefore ||
      input.tape.entry.url,
    `op-${input.operationIndex}-after`,
  );
  const action = operationToAction(
    input.operation,
    input.argName,
    input.selectorArgName,
  );
  const atomId = sha256({
    selector: action.selector,
    method: action.method,
    instruction: input.operation.instruction,
  });
  return {
    id: sha256({
      fallbackTapeId: input.tape.id,
      operationId: input.operation.id,
      operationIndex: input.operationIndex,
      createdAt: input.now,
    }),
    name: `operation_${input.operationIndex}_${input.operation.kind}`,
    type: stepTypeForOperation(input.operation),
    before,
    after,
    atomId,
    instruction: input.operation.instruction,
    actions: [action],
    status: "recorded",
    validationHash: after.fingerprint.hash,
    validators: [],
    selectorDiagnostics: selectorDiagnosticsForOperation(
      input.operation,
      action.selector,
    ),
    writesToPlatform: input.writesToPlatform,
    createdAt: input.now,
  };
}

function selectorDiagnosticsForOperation(
  operation: FallbackOperation,
  selectedSelector: string,
): TapeStep["selectorDiagnostics"] {
  const candidates = operation.selectorCandidates || [];
  const selected =
    candidates.find((candidate) => candidate.selector === selectedSelector) ||
    (selectedSelector
      ? {
          selector: selectedSelector,
          selectorKind:
            selectedSelector.startsWith("http://") ||
            selectedSelector.startsWith("https://")
              ? "url"
              : operation.selectorKind && operation.selectorKind !== "unknown"
                ? operation.selectorKind
                : "css",
          stability: "medium" as const,
          reason: "selected fallback operation selector",
        }
      : undefined);
  if (!selected) return undefined;
  return {
    selected,
    alternatives: candidates.filter(
      (candidate) => candidate.selector !== selected.selector,
    ),
  };
}

function operationToAction(
  operation: FallbackOperation,
  argName?: string,
  selectorArgName?: string,
): Action {
  const selector = selectorForAction(operation, selectorArgName);
  if (!selector) {
    throw new Error(`Operation ${operation.id} does not have a selector.`);
  }
  if (operation.kind === "goto" || operation.kind === "snapshot") {
    return {
      selector,
      method: "goto",
      description: operation.instruction,
      arguments: [],
    };
  }
  if (operation.kind === "fill") {
    return {
      selector,
      method: "fill",
      description: operation.instruction,
      arguments: [
        operation.valuePlaceholder ||
          (argName ? `%${argName}%` : operation.commandArgs?.[1] || ""),
      ].filter(Boolean),
    };
  }
  if (operation.kind === "type") {
    return {
      selector,
      method: "type",
      description: operation.instruction,
      arguments: [
        operation.valuePlaceholder ||
          (argName
            ? `%${argName}%`
            : operation.commandArgs?.slice(1).join(" ") || ""),
      ].filter(Boolean),
    };
  }
  if (operation.kind === "press") {
    return {
      selector,
      method: "press",
      description: operation.instruction,
      arguments: [operation.commandArgs?.[0] || ""].filter(Boolean),
    };
  }
  if (
    operation.kind === "dblclick" ||
    operation.kind === "hover" ||
    operation.kind === "check" ||
    operation.kind === "uncheck"
  ) {
    return {
      selector,
      method: operation.kind,
      description: operation.instruction,
      arguments: [],
    };
  }
  if (operation.kind === "select") {
    return {
      selector,
      method: "select",
      description: operation.instruction,
      arguments: operation.commandArgs?.slice(1) || [],
    };
  }
  if (operation.kind === "upload") {
    return {
      selector,
      method: "upload",
      description: operation.instruction,
      arguments: operation.commandArgs?.slice(1) || [],
    };
  }
  return {
    selector,
    method: "click",
    description: operation.instruction,
    arguments: [],
  };
}

function selectorForAction(
  operation: FallbackOperation,
  selectorArgName?: string,
): string {
  const rawSelector =
    operation.kind === "snapshot"
      ? operation.urlAfter || operation.urlBefore || ""
      : operation.kind === "press" || operation.kind === "type"
      ? keyboardTargetSelector(operation)
      : operation.selector || "";
  return selectorArgName
    ? parameterizeSelector(rawSelector, selectorArgName)
    : rawSelector;
}

function keyboardTargetSelector(operation: FallbackOperation): string {
  const selector = operation.selector || "";
  const firstArg = operation.commandArgs?.[0] || "";
  if (!selector || selector === firstArg) return "body";
  return selector;
}

function stepTypeForOperation(operation: FallbackOperation): TapeStep["type"] {
  if (operation.kind === "goto") return "navigate";
  if (operation.kind === "snapshot") return "navigate";
  if (operation.kind === "fill" || operation.kind === "type") return "fill";
  if (operation.kind === "select") return "select";
  if (operation.kind === "upload") return "upload";
  if (operation.kind === "press") return "submit";
  if (operation.kind === "hover") return "hover";
  return "click";
}

function argsForSlice(
  executable: Array<{ operationIndex: number; operation: FallbackOperation }>,
  explicitArgs: ProcessArg[],
  argumentBindings: Map<number, string>,
  selectorBindings: Map<number, string>,
): ProcessArg[] {
  const explicitByName = new Map(explicitArgs.map((arg) => [arg.name, arg]));
  const names = new Set<string>();
  for (const { operationIndex, operation } of executable) {
    const argumentBound = argumentBindings.get(operationIndex);
    if (argumentBound) names.add(argumentBound);
    const selectorBound = selectorBindings.get(operationIndex);
    if (selectorBound) names.add(selectorBound);
    const placeholder = operation.valuePlaceholder?.match(/^%(.+)%$/)?.[1];
    if (placeholder) names.add(placeholder);
  }
  return [...names].map(
    (name) =>
      explicitByName.get(name) || {
        name,
        required: true,
        description: `${name} argument`,
      },
  );
}

function parameterizeSelector(selector: string, argName: string): string {
  const placeholder = `%${argName}%`;
  if (selector.startsWith("https://www.instagram.com/")) {
    return selector.replace(
      /^https:\/\/www\.instagram\.com\/[^/?#]+\/?/,
      `https://www.instagram.com/${placeholder}/`,
    );
  }
  if (selector.startsWith("https://instagram.com/")) {
    return selector.replace(
      /^https:\/\/instagram\.com\/[^/?#]+\/?/,
      `https://instagram.com/${placeholder}/`,
    );
  }
  if (selector.startsWith("role=button[name=")) {
    return selector.replace(/\[name=.+\]$/, `[name=/${placeholder}/]`);
  }
  if (selector.includes(`"`)) {
    return selector.replace(/"[^"]+"/, `"${placeholder}"`);
  }
  if (selector.includes(`'`)) {
    return selector.replace(/'[^']+'/, `'${placeholder}'`);
  }
  return selector;
}

function syntheticState(tape: FallbackTape, url: string, label: string): State {
  const urlShape = shapeUrl(url);
  const hash = sha256({
    fallbackTapeId: tape.id,
    label,
    urlShape,
  });
  return {
    id: hash,
    domain: tape.domain,
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
  };
}
