import type {
  DuplicateCandidate,
  FallbackTape,
  Postcondition,
  ProcessTapeSummary,
} from "./contracts.js";

export function findDuplicateCandidates(
  tape: FallbackTape,
  existingCommands: ProcessTapeSummary[],
): DuplicateCandidate[] {
  const fallbackPostconditions = fallbackPostconditionsFor(tape);
  const finalPath = finalUrlPath(tape);
  const intentTokens = tokenSet(tape.intent);
  const fallbackArgNames = new Set(tape.args.map((arg) => arg.name));

  return existingCommands
    .map((command) => {
      const reasons = candidateReasons({
        command,
        fallbackPostconditions,
        finalPath,
        intentTokens,
        fallbackArgNames,
      });
      if (!reasons.length) return undefined;
      return {
        processName: command.name,
        description: command.description,
        writesToPlatform: command.writesToPlatform,
        args: command.args,
        outputs: command.outputs || [],
        postconditions: command.postconditions || [],
        reasons,
      };
    })
    .filter((candidate): candidate is DuplicateCandidate => Boolean(candidate))
    .sort((a, b) => a.processName.localeCompare(b.processName));
}

function candidateReasons(input: {
  command: ProcessTapeSummary;
  fallbackPostconditions: Postcondition[];
  finalPath?: string;
  intentTokens: Set<string>;
  fallbackArgNames: Set<string>;
}): string[] {
  const reasons = new Set<string>();
  const commandPostconditions = input.command.postconditions || [];

  if (
    hasSharedPostcondition(input.fallbackPostconditions, commandPostconditions)
  ) {
    reasons.add("shared_postcondition");
  }

  if (
    input.finalPath &&
    commandPostconditions.some((postcondition) =>
      urlPostconditionMatchesPath(postcondition, input.finalPath),
    )
  ) {
    reasons.add("same_browser_destination");
  }

  if (
    hasIntentOverlap(
      input.intentTokens,
      tokenSet(`${input.command.name} ${input.command.description}`),
    )
  ) {
    reasons.add("intent_overlap");
  }

  const sharedArgs = input.command.args.filter((arg) =>
    input.fallbackArgNames.has(arg.name),
  );
  if (sharedArgs.length)
    reasons.add(`shared_args:${sharedArgs.map((arg) => arg.name).join(",")}`);

  return [...reasons].sort();
}

function fallbackPostconditionsFor(tape: FallbackTape): Postcondition[] {
  const postconditions = [
    ...(tape.steps[tape.steps.length - 1]?.validators || []),
  ];
  const path = finalUrlPath(tape);
  if (path && path !== "/")
    postconditions.push({ type: "url_contains", value: path });
  return dedupePostconditions(postconditions);
}

function hasSharedPostcondition(
  a: Postcondition[],
  b: Postcondition[],
): boolean {
  const keys = new Set(a.map((postcondition) => JSON.stringify(postcondition)));
  return b.some((postcondition) => keys.has(JSON.stringify(postcondition)));
}

function urlPostconditionMatchesPath(
  postcondition: Postcondition,
  path: string,
): boolean {
  if (
    postcondition.type !== "url_equals" &&
    postcondition.type !== "url_contains"
  )
    return false;
  const expected = normalizeUrlishPath(postcondition.value);
  if (!expected || expected === "/") return false;
  return (
    expected === path || path.includes(expected) || expected.includes(path)
  );
}

function finalUrlPath(tape: FallbackTape): string | undefined {
  const finalUrl =
    tape.steps[tape.steps.length - 1]?.after.url || tape.entry.url;
  return normalizeUrlishPath(finalUrl);
}

function normalizeUrlishPath(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.pathname || "/";
  } catch {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith("/")
      ? trimmed
      : `/${trimmed.replace(/^\/+/, "")}`;
  }
}

function tokenSet(value: string): Set<string> {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "in",
    "of",
    "open",
    "page",
    "the",
    "to",
  ]);
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length > 2 && !stopWords.has(token)),
  );
}

function hasIntentOverlap(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((token) => b.has(token));
  return shared.length >= 2 || shared.length / Math.min(a.size, b.size) >= 0.6;
}

function dedupePostconditions(
  postconditions: Postcondition[],
): Postcondition[] {
  const seen = new Set<string>();
  const deduped: Postcondition[] = [];
  for (const postcondition of postconditions) {
    const key = JSON.stringify(postcondition);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(postcondition);
  }
  return deduped;
}
