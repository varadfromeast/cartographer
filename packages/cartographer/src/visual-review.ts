import path from "node:path";
import type {
  Domain,
  Postcondition,
  ProcessName,
  RuntimeArgs,
  TaskId,
  VisualReviewArtifact,
} from "./contracts.js";
import { ensureDir, writeJsonFile } from "./fs-json.js";
import { sha256 } from "./hash.js";
import { visualReviewPath } from "./paths.js";

export async function createPendingVisualReview(input: {
  domain: Domain;
  processName: ProcessName;
  taskId?: TaskId;
  screenshotPath: string;
  url?: string;
  postconditions?: Postcondition[];
  args?: RuntimeArgs;
}): Promise<VisualReviewArtifact> {
  const createdAt = new Date().toISOString();
  const boundPostconditions = bindPostconditions(
    input.postconditions || [],
    input.args,
  );
  const expected = expectedRenderedOutcome(boundPostconditions, input.args);
  const artifact: VisualReviewArtifact = {
    schemaVersion: 1,
    id: sha256({
      domain: input.domain,
      processName: input.processName,
      taskId: input.taskId,
      screenshotPath: input.screenshotPath,
      createdAt,
    }).slice(0, 24),
    domain: input.domain,
    subject: {
      kind: "runtime_process",
      processName: input.processName,
      taskId: input.taskId,
    },
    status: "pending",
    reviewer: "vlm",
    source: {
      type: "final_screenshot",
      screenshotPath: input.screenshotPath,
      url: input.url,
      capturedAt: createdAt,
    },
    question: visualReviewQuestion(input.processName, expected),
    expected,
    checks: [
      "The expected result appears in the rendered page, not only in an input, textbox, or composer.",
      "The page does not show an obvious error, blocked action, login wall, or unsent draft state.",
      "The visible final state is consistent with the command that just ran.",
    ],
    postconditions: boundPostconditions,
    createdAt,
  };
  const outputPath = visualReviewPath(input.domain, artifact.id);
  await ensureDir(path.dirname(outputPath));
  await writeJsonFile(outputPath, artifact);
  return artifact;
}

function visualReviewQuestion(
  processName: ProcessName,
  expected: string,
): string {
  return [
    `Does the final screenshot show that \`${processName}\` reached its intended rendered state?`,
    `Expected: ${expected}`,
    "Answer with passed, failed, or unclear, and include a short reason.",
  ].join(" ");
}

function expectedRenderedOutcome(
  postconditions: Postcondition[],
  args?: RuntimeArgs,
): string {
  const rendered = postconditions.find(
    (postcondition) => postcondition.type === "rendered_text_contains",
  );
  if (rendered && "value" in rendered) {
    return `Rendered page contains ${JSON.stringify(rendered.value)} outside editable composer/input controls.`;
  }
  const text = postconditions.find(
    (postcondition) => postcondition.type === "text_contains",
  );
  if (text && "value" in text) {
    return `Rendered page contains ${JSON.stringify(text.value)}.`;
  }
  const urlContains = postconditions.find(
    (postcondition) => postcondition.type === "url_contains",
  );
  if (urlContains && "value" in urlContains) {
    return `Current URL contains ${JSON.stringify(urlContains.value)} and the page shows no failure state.`;
  }
  const message = args?.message;
  if (message !== undefined) {
    return `Latest rendered result contains message ${JSON.stringify(String(message))} outside editable composer/input controls.`;
  }
  return "The final rendered page visibly matches the command's intended success state.";
}

function bindPostconditions(
  postconditions: Postcondition[],
  args?: RuntimeArgs,
): Postcondition[] {
  if (!args) return postconditions;
  const replacements = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [`%${key}%`, String(value)]),
  );
  return postconditions.map((postcondition) => {
    if ("value" in postcondition) {
      return {
        ...postcondition,
        value: replacePlaceholders(postcondition.value, replacements),
      };
    }
    return postcondition;
  });
}

function replacePlaceholders(
  value: string,
  replacements: Record<string, string>,
): string {
  let next = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    next = next.split(token).join(replacement);
  }
  return next;
}
