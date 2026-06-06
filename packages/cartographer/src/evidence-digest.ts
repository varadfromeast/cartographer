import fs from "node:fs/promises";
import type {
  EvidenceDigest,
  EvidenceProvenance,
  FallbackOperation,
  FallbackTape,
  ObservedLink,
  ObservedText,
  PageKindSignal,
  RepeatedTextPattern,
  SnapshotControlSummary,
} from "./contracts.js";

const FOLLOWER_TEXT_RE = /\b[\d,.]+(?:\.\d+)?\s*[KMB]?\s+followers\b/gi;
const LINK_RE =
  /- link "([^"]+)"(?: \[ref=[^\]]+\])?(?: \[cursor=pointer\])?:\n\s+- \/url: ([^\n]+)/g;

export async function createEvidenceDigest(
  tape: FallbackTape,
): Promise<EvidenceDigest> {
  const observedTexts: ObservedText[] = [];
  const observedLinks: ObservedLink[] = [];
  const observedControls: SnapshotControlSummary[] = [];
  const pageKinds: PageKindSignal[] = [];

  for (const [operationIndex, operation] of (tape.operations || []).entries()) {
    const paths = evidencePathsForOperation(operation);
    for (const evidencePath of paths) {
      const raw = await readSmallText(evidencePath);
      if (!raw) continue;
      const label = evidenceLabel(evidencePath);
      const text = compactEvidenceText(raw);
      if (text) {
        observedTexts.push({
          text,
          label,
          evidencePath,
          operationIndex,
          selector: operation.selector,
        });
      }
      observedLinks.push(...extractLinks(raw, evidencePath, operationIndex));
    }

    if (operation.evidenceSummary?.controls?.length) {
      observedControls.push(...operation.evidenceSummary.controls);
    }
    const pageKind = pageKindForOperation(operation);
    if (pageKind) pageKinds.push(pageKind);
  }

  const repeatedTextPatterns = repeatedPatterns(observedTexts);
  const finalOutputProvenance = createFinalOutputProvenance(
    tape.operations || [],
    observedTexts,
  );

  return {
    observedTexts: observedTexts.slice(0, 80),
    observedLinks: observedLinks.slice(0, 120),
    observedControls: dedupeControls(observedControls).slice(0, 80),
    repeatedTextPatterns,
    pageKinds,
    finalOutputProvenance,
  };
}

export function followerTexts(text: string): string[] {
  return unique(
    [...text.matchAll(FOLLOWER_TEXT_RE)].map((match) =>
      match[0].replace(/\s+/g, " ").trim(),
    ),
  );
}

function evidencePathsForOperation(operation: FallbackOperation): string[] {
  const paths = new Set<string>();
  if (operation.evidencePath) paths.add(operation.evidencePath);
  if (operation.evidenceSummaryPath) paths.add(operation.evidenceSummaryPath);
  for (const path of Object.values(operation.evidencePaths || {})) {
    if (
      path.endsWith("snapshot.yaml") ||
      path.endsWith("stdout.txt") ||
      path.endsWith("summary.json")
    ) {
      paths.add(path);
    }
  }
  return [...paths];
}

function evidenceLabel(evidencePath: string): string {
  const parts = evidencePath.split("/");
  return parts.slice(-3).join("/");
}

async function readSmallText(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw.slice(0, 120_000);
}

function compactEvidenceText(raw: string): string {
  const followers = followerTexts(raw);
  const profileLines = raw
    .split("\n")
    .filter((line) =>
      /\b(followers|following|posts|Message|Verified|profile picture)\b/i.test(
        line,
      ),
    )
    .slice(0, 40)
    .map((line) => line.trim());
  return unique([...followers, ...profileLines])
    .join("\n")
    .slice(0, 4000);
}

function extractLinks(
  raw: string,
  evidencePath: string,
  operationIndex: number,
): ObservedLink[] {
  const links: ObservedLink[] = [];
  for (const match of raw.matchAll(LINK_RE)) {
    links.push({
      text: match[1].replace(/\s+/g, " ").trim(),
      href: match[2].trim(),
      evidencePath,
      operationIndex,
    });
  }
  return links;
}

function repeatedPatterns(
  observedTexts: ObservedText[],
): RepeatedTextPattern[] {
  const followerEvidence = new Map<string, Set<string>>();
  for (const observed of observedTexts) {
    for (const value of followerTexts(observed.text)) {
      if (!followerEvidence.has(value)) followerEvidence.set(value, new Set());
      followerEvidence.get(value)?.add(observed.evidencePath);
    }
  }
  const followerValues = [...followerEvidence.keys()];
  if (!followerValues.length) return [];
  return [
    {
      name: "follower_count_text",
      values: followerValues,
      evidencePaths: unique(
        [...followerEvidence.values()].flatMap((paths) => [...paths]),
      ),
      count: followerValues.length,
    },
  ];
}

function createFinalOutputProvenance(
  operations: FallbackOperation[],
  observedTexts: ObservedText[],
): EvidenceProvenance[] {
  const provenance: EvidenceProvenance[] = [];
  for (const [operationIndex, operation] of operations.entries()) {
    if (operation.kind !== "fill" && operation.kind !== "type") continue;
    const value = fillValue(operation);
    if (!value) continue;
    const matchedPatterns: string[] = [];
    if (followerTexts(value).length)
      matchedPatterns.push("follower_count_text");
    const sourceEvidencePaths = observedTexts
      .filter((observed) =>
        followerTexts(observed.text).some((follower) =>
          value.includes(follower),
        ),
      )
      .map((observed) => observed.evidencePath);
    if (!matchedPatterns.length && !sourceEvidencePaths.length) continue;
    provenance.push({
      value,
      destinationOperationIndex: operationIndex,
      destinationEvidencePath:
        operation.evidencePath || operation.evidenceSummaryPath,
      sourceEvidencePaths: unique(sourceEvidencePaths),
      matchedPatterns,
    });
  }
  return provenance;
}

function fillValue(operation: FallbackOperation): string {
  const args = operation.commandArgs || [];
  if (operation.kind === "fill" && args.length >= 2) {
    return args.slice(1).join(" ");
  }
  if (operation.kind === "type" && args.length >= 1) return args.join(" ");
  return "";
}

function pageKindForOperation(
  operation: FallbackOperation,
): PageKindSignal | undefined {
  const url = operation.urlAfter || operation.urlBefore;
  if (!url) return undefined;
  const path = pathFromUrl(url);
  if (path === "/direct/inbox/") {
    return {
      kind: "instagram_direct_inbox",
      confidence: "high",
      url,
      evidencePath: operation.evidencePath || operation.evidenceSummaryPath,
      reason: "direct inbox URL",
    };
  }
  if (path?.startsWith("/direct/t/")) {
    return {
      kind: "instagram_direct_thread",
      confidence: "high",
      url,
      evidencePath: operation.evidencePath || operation.evidenceSummaryPath,
      reason: "direct thread URL",
    };
  }
  if (path?.startsWith("/explore/search/")) {
    return {
      kind: "instagram_search_results",
      confidence: "medium",
      url,
      evidencePath: operation.evidencePath || operation.evidenceSummaryPath,
      reason: "search results URL",
    };
  }
  if (profileUsernameFromPath(path || "")) {
    return {
      kind: "instagram_profile",
      confidence: "medium",
      url,
      evidencePath: operation.evidencePath || operation.evidenceSummaryPath,
      reason: "profile-shaped URL",
    };
  }
  return undefined;
}

function pathFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function profileUsernameFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (!match) return null;
  return [
    "accounts",
    "direct",
    "explore",
    "p",
    "reel",
    "stories",
    "about",
  ].includes(match[1])
    ? null
    : match[1];
}

function dedupeControls(
  controls: SnapshotControlSummary[],
): SnapshotControlSummary[] {
  const seen = new Set<string>();
  const out: SnapshotControlSummary[] = [];
  for (const control of controls) {
    const key = `${control.role}:${control.name || ""}:${control.href || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(control);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
