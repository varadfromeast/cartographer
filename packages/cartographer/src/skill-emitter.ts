import fs from "node:fs/promises";
import path from "node:path";
import type { Domain, ProcessTapeSummary, TapeCatalog } from "./contracts.js";
import { readJsonFile } from "./fs-json.js";
import {
  binDir,
  catalogPath,
  manifestPath,
  skillPath,
  slugifyName,
} from "./paths.js";
import {
  PROMOTION_POLICY_ADVISORY_RULES,
  PROMOTION_POLICY_HARD_RULES,
} from "./promotion-review-prompt.js";
import { PLAYWRIGHT_CLI_BASE_COMMANDS } from "./playwright-cli-substrate.js";

export async function emitSkillMd(
  domain: Domain,
  outputPath = skillPath(domain),
): Promise<string> {
  const catalog = await readJsonFile<TapeCatalog>(catalogPath(domain));
  if (!catalog) throw new Error(`No tape catalog found for ${domain}`);

  const binName = `${domain.replace(/\./g, "-")}-cli`;
  const cliPath = path.join(binDir(), binName);
  const cartographerCli = "cg";
  const domainAlias = domain === "instagram.com" ? "instagram" : domain;
  const commands = Object.values(catalog.processes).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const commandSections = renderCommandSections(
    commands,
    domain,
    domainAlias,
    cartographerCli,
  );
  const lines = [
    "---",
    `name: ${domain.replace(/\./g, "-")}-cli`,
    `description: Route ${domain} task segments to deterministic CLI commands first, then Cartographer fallback when no command directly fits or a command fails.`,
    "---",
    "",
    `# ${domain} CLI Skill`,
    "",
    "Use a listed CLI command only when it directly matches the current task segment. Fallback when no listed command fits or a command returns `success:false`.",
    "",
    "For exact args, outputs, postconditions, write flags, and failure fields, read `manifest.json` beside this file.",
    "",
    `Do not use a separate browser, raw CDP session, standalone Playwright script, or external browser automation as acquisition fallback. Browser fallback must go through \`${cartographerCli} use\`/\`${cartographerCli} shell\` or \`${cartographerCli} pw\` so Cartographer can record evidence and enforce review.`,
    "",
    "## CLI Preflight",
    "",
    `- \`cg\` should be on PATH via shell startup: \`export PATH="${binDir()}:$PATH"\`. Open a new shell or source your shell rc file if \`cg\` is missing.`,
    `- The absolute Cartographer CLI path is \`${path.join(binDir(), "cg")}\`.`,
    `- Doctor command: \`${cartographerCli} doctor ${domainAlias} --task-id <taskId>\` reports task, generated skill, browser, CDP, and Playwright daemon state.`,
    "",
    "## Site Graph",
    "",
    `Cartographer also compiles compact site graphs from trusted commands, fallback tapes, task evidence, and rejected review artifacts. Run \`${cartographerCli} analyze-site ${domainAlias}\` to refresh the graph, then use \`${cartographerCli} site-summary ${domainAlias}\`, \`${cartographerCli} site-node ${domainAlias} <node-id>\`, and \`${cartographerCli} site-actions ${domainAlias} <node-id>\` to inspect it.`,
    "",
    "The graph is for planning and exploration. Nodes are website surfaces; actions are directed transitions or in-place operations. Trusted CLI commands attach to actions, not nodes. Default graph output hides selectors; selectors stay in evidence and generated CLI implementations.",
    "",
    "Rejected fallback tapes are included by default with downgraded trust. This keeps failed writes and brittle selectors visible as weak, failed, or rerecord-needed actions without hiding the underlying surface capability.",
    "",
    "Candidate graph edges are intentionally inclusive: compose, send, follow, post, input, and destructive-looking controls remain visible with risk metadata and warnings.",
    "",
    "## Commands",
    "",
    ...commandSections,
    "",
    "## Routing",
    "",
    "- Use CLI first when one command directly fits the segment.",
    `- For agentic live work, prefer \`${cartographerCli} use ${domainAlias} --task "<task>"\`; the shell keeps task id, segment intent, one hot recorded Playwright CLI session, fallback recording, acquired-command routing, review, and complete in one context.`,
    "- For a new live task with no task ID explicitly provided by the user, start a fresh task. Do not search for, reuse, review, close, or repair an older task with similar wording.",
    "- Treat the task ID printed by the current `cg use`/`begin-task` invocation as the only active task for that run. Ignore previous task IDs found in old review files, shell history, or summaries.",
    `- Prefer \`${cartographerCli} exec-command ${domainAlias} <command>\` for acquired commands; it resolves generated site commands without relying on PATH.`,
    `- The generated site binary also exists at \`${cliPath}\`, but \`${binName}\` may not be on PATH.`,
    "- When a task is active, pass `--task-id <taskId>` to every CLI command so commands reuse the task browser.",
    "- If a login screen appears, Cartographer pauses; complete login in the open browser, then press Enter in the waiting command.",
    "- Use `--dry-run` before write-capable commands when inspecting behavior.",
    "- Add `--confirm-write` when a generated command requires explicit write confirmation.",
    "- Read command JSON and prefer declared `outputs` when present.",
    "- If a scoped command fails with `precondition_failed`, use the returned `suggestedAutoEnterProcessName`, fallback, or rerun with explicit `--auto-chain` to execute declared non-write precondition commands before retrying the target.",
    "- If fallback is active for the same `--task-id`, a matching CLI command may still run; Cartographer journals it as non-promotable context.",
    "",
    "## Fallback",
    "",
    "For unfamiliar live work, start the task shell:",
    "",
    "```bash",
    `${cartographerCli} use ${domainAlias} --task "<task>"`,
    "```",
    "",
    `Inside the shell, short commands keep fallback recorded while avoiding repeated \`--task-id\`/\`--intent\`. Fallback operations reuse the same Playwright CLI attachment, so multi-step work should stay in the shell instead of spawning one \`${cartographerCli} pw\` process per micro-action:`,
    "",
    "```text",
    "intent open inbox",
    "snapshot",
    "click e15",
    'fill placeholder="Message..." "hello"',
    "press Enter",
    'press placeholder="Message..." Enter',
    "review",
    "exit",
    "```",
    "",
    "The shell also accepts piped scripts for deterministic smoke runs:",
    "",
    "```bash",
    `${cartographerCli} use ${domainAlias} --task "<task>" <<'EOF'`,
    'complete --no-acquisition-reason "smoke only"',
    "EOF",
    "```",
    "",
    "Acquired commands can also be invoked directly inside the shell with `commandName arg=value`; unknown shell commands are resolved against the acquired command catalog before failing. Use `--auto-chain` on an acquired command to run declared non-write precondition commands before retrying a scoped target.",
    "",
    "For non-interactive fallback, create a task first:",
    "",
    "```bash",
    `${cartographerCli} begin-task ${domainAlias} --intent "<task>"`,
    "```",
    "",
    "When no command directly fits one segment and an interactive shell is not appropriate, use the recorded Playwright CLI wrapper:",
    "",
    "```bash",
    `${cartographerCli} pw ${domainAlias} --task-id "<taskId>" --intent "<segment>" snapshot`,
    "```",
    "",
    "Then continue with normal Playwright CLI commands through Cartographer:",
    "",
    "```bash",
    `${cartographerCli} pw ${domainAlias} --task-id "<taskId>" goto https://www.instagram.com/direct/inbox/`,
    `${cartographerCli} pw ${domainAlias} --task-id "<taskId>" snapshot`,
    "```",
    "",
    `\`${cartographerCli} pw\` records automatically, but it is a cold one-command path. Prefer the shell for live multi-operation fallback because it keeps one task browser and one Playwright CLI session attached. \`review-task\` materializes the active operation journal into fallback tapes before creating review artifacts.`,
    "",
    "A changed `--intent` starts a new fallback segment automatically. Use specific segment intents such as `search profiles`, `inspect profile`, `open inbox`, or `send message` instead of reusing the first broad intent.",
    "",
    "Each Playwright CLI operation writes deterministic evidence, including compact `summary.json` files. Write-adjacent operations also write `write-grounding.json` and `action-discovery.json` when selector probes can run. Read review summaries and evidence warnings before opening full snapshots.",
    "",
    "Fallback segments write an `events.jsonl` journal. Playwright CLI fallback operations are reviewable promotion evidence; acquired site CLI events in that journal are context only (`surface:cli`, `promotionEligible:false`).",
    "",
    `Fallback accepts the Playwright CLI command surface through the shell or \`${cartographerCli} pw\`: ${PLAYWRIGHT_CLI_BASE_COMMANDS.map((item) => `\`${item}\``).join(", ")}.`,
    "",
    'Selectors may be snapshot refs, CSS, XPath, or Playwright locator forms: `e15`, `role=button[name="..."]`, `role=button[name=/.../]`, `text="..."`, `label="..."`, `placeholder="..."`, `testid="..."`.',
    "",
    "Do not promote raw snapshot refs directly. Use selector diagnostics as evidence, then promote only reusable site actions.",
    "",
    "Current trusted commands include `send-message-current-thread`, which is write-submit risk. If sending a message is required and the command fits the task, use it with the required write confirmation and review the rendered postcondition evidence. If fallback is used instead, record it through Cartographer and review it. Reject or rerecord write candidates that rely on raw snapshot refs instead of durable selector bundles and rendered final-state postconditions.",
    "",
    "## Closeout",
    "",
    "If fallback was used, create the task review:",
    "",
    "```bash",
    `${cartographerCli} review-task ${domainAlias} --task-id "<taskId>"`,
    "```",
    "",
    "Read the returned `reviewPath` first. It is compact and candidate-first. It lists the acquisition scorecard, obligations, promotion candidates, state transitions, and key selectors with links to evidence. Use fallback-level `REVIEW.md` files only for deeper inspection.",
    "",
    "Handle acquisition obligations before rejecting whole fallback tapes. Give each handled candidate an `agentEasyToPromote` rating so weak but valuable rerecord opportunities are visible.",
    "",
    "Review rule: a fallback tape is evidence; each proposed or custom operation slice is a candidate skill. Promote reusable safe slices independently. Reject the remaining private, noisy, transient, or task-specific slices.",
    "",
    "Write one `review_batch` decision JSON using the returned `decisionTemplatePath` as the starting structure. One fallback may have multiple decisions when it contains multiple independent slices. Use `reviewItemId` for proposed slices, or exact `operationIndexes` for a custom slice. Use action `rerecord` for valuable candidates that need a narrow rerun with better selector probes; rerecord does not mutate the catalog.",
    "",
    "Apply the decision:",
    "",
    "```bash",
    `${cartographerCli} apply-promotion-decision ${domainAlias} --decision-file "<decision.json>"`,
    "```",
    "",
    "Promotion applies a replay gate before mutating skills: non-write commands with no runtime args are replayed in the task browser and must satisfy postconditions. Write-capable commands are not auto-replayed because replay may send, save, delete, or publish data. If apply fails, fix the decision or reject the slice; do not manually patch the catalog.",
    "",
    "Close only after apply succeeds:",
    "",
    "```bash",
    `${cartographerCli} complete-task ${domainAlias} --task-id "<taskId>"`,
    "```",
    "",
    "For a compact closeout check after completion:",
    "",
    "```bash",
    `${cartographerCli} task-summary ${domainAlias} --task-id "<taskId>"`,
    "```",
    "",
    "If all fallback segments were abandoned and no acquisition packet exists, close only with an explicit reason:",
    "",
    "```bash",
    `${cartographerCli} complete-task ${domainAlias} --task-id "<taskId>" --no-acquisition-reason "<why no reusable evidence was saved>"`,
    "```",
    "",
    "If any lifecycle command returns `success:false`, run the returned `command` before continuing.",
    "",
    "## Final Report",
    "",
    "After a live task, final response must include: `taskId`, whether fallback was used, review status, acquisition scorecard quality, promoted commands, rejected candidates, and rerecord candidates. If any item is absent, say `unknown` and name the missing artifact.",
    "",
  ];

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

export async function emitSkillManifest(
  domain: Domain,
  outputPath = manifestPath(domain),
): Promise<string> {
  const catalog = await readJsonFile<TapeCatalog>(catalogPath(domain));
  if (!catalog) throw new Error(`No tape catalog found for ${domain}`);
  const domainAlias = domain === "instagram.com" ? "instagram" : domain;
  const cartographerCli = "cg";

  const manifest = {
    schemaVersion: 1,
    domain,
    generatedAt: new Date().toISOString(),
    agentContract: {
      toolSelection: "agent-controlled",
      commandExecution: "cli-controlled",
      successRule:
        "success is true only when actions complete and final postconditions pass",
      driftRule:
        "hash drift is diagnostic and does not fail a command by itself",
      fallbackRule:
        "use fallback recording when no listed command fits or an invoked command fails",
      acquisitionFallbackRule: `browser acquisition fallback must go through ${cartographerCommandPhrase(cartographerCli, "use")}, ${cartographerCommandPhrase(cartographerCli, "shell")}, or ${cartographerCommandPhrase(cartographerCli, "pw")}; raw CDP, standalone Playwright scripts, and separate browsers are external escape hatches and do not satisfy acquisition review`,
      learningRule:
        "if fallback is used, end-task review is required; every reusable fallback, acquisition obligation, and high-value read/write candidate should be promoted, rejected, or marked for rerecording",
      selectorRule:
        "selectors may be snapshot refs, CSS, XPath, or Cartographer Playwright locator forms",
      taskBrowserRule: `when --task-id is passed, acquired CLI commands and ${cartographerCommandPhrase(cartographerCli, "pw")} commands attach to a Cartographer-owned browser using the site default profile; complete-task closes the browser session`,
      loginWaitRule:
        "if Instagram shows a login screen, Cartographer pauses for human login and resumes after Enter",
      fallbackSessionRule: `a failed shell or ${cartographerCommandPhrase(cartographerCli, "pw")} selector/action is recoverable inside the same task browser; retry with a better selector instead of starting another task. prefer ${cartographerCommandPhrase(cartographerCli, "use")} for multi-operation work because it keeps a hot recorded Playwright CLI session attached`,
      segmentJournalRule: `active fallback segments write events.jsonl; ${cartographerCommandPhrase(cartographerCli, "pw")} commands are fallback evidence, acquired CLI commands run with the same taskId are journaled as non-promotable context`,
      promotionEligibilityRule:
        "review may use all journal events as context, but promotion ignores events with promotionEligible:false",
      promotionReplayRule:
        "apply-promotion-decision replays non-write/no-arg promotions in the task browser before catalog mutation; write-capable promotions are not auto-replayed",
      scriptedFallbackRule: `recorded fallback uses shell commands or ${cartographerCommandPhrase(cartographerCli, "pw")} <playwright-cli-command>; review-task materializes active pw journals into fallback tapes`,
      finalReportRule:
        "after live work, final response must include taskId, fallback used, review status, acquisition scorecard quality, promoted commands, rejected candidates, and rerecord candidates; use unknown only when the artifact is genuinely unavailable",
      stateScopeRule:
        "commands may declare stateScope; Cartographer checks preconditions before execution and returns precondition_failed with suggestedAutoEnterProcessName/fallbackRecommended when unmet",
      supportedPlaywrightSelectors: [
        "e15",
        'testid="..."',
        'role=button[name="..."]',
        "role=button[name=/.../]",
        'label="..."',
        'placeholder="..."',
        'title="..."',
        'text="..."',
      ],
    },
    taskLifecycle: {
      beginTaskCommand: `${cartographerCli} begin-task ${domainAlias} --intent <task>`,
      taskFileRule: `begin-task persists task.json immediately; ${cartographerCommandPhrase(cartographerCli, "pw")} --task-id appends segment.json files under that task`,
      fallbackCreatesLearningDebt: true,
      closeoutRequiredWhenFallbackUsed: true,
      completeTaskCommand: `${cartographerCli} complete-task ${domainAlias} --task-id <taskId>`,
      noAcquisitionCompleteCommand: `${cartographerCli} complete-task ${domainAlias} --task-id <taskId> --no-acquisition-reason <reason>`,
      noAcquisitionCloseRule:
        "if fallback segments exist but no acquisition packet was saved, completion requires an explicit no-acquisition reason",
      taskReviewCommand: `${cartographerCli} review-task ${domainAlias} --task-id <taskId>`,
      applyDecisionCommand: `${cartographerCli} apply-promotion-decision ${domainAlias} --decision-file <decision.json>`,
      decisions: ["promote", "reject", "delete", "rerecord"],
      promotionCriteria: [
        "generic",
        "repeatable",
        "safe",
        "deterministic-postconditions",
      ],
      promotionPolicy: {
        name: "v1",
        enforced: PROMOTION_POLICY_HARD_RULES,
        advisory: PROMOTION_POLICY_ADVISORY_RULES,
      },
      promotionDecisionWorkflow: {
        createReviewCommand: `${cartographerCli} create-promotion-review ${domainAlias} <fallback-id>`,
        applyDecisionCommand: `${cartographerCli} apply-promotion-decision ${domainAlias} --decision-file <decision.json>`,
        agentInstruction:
          "For task review, reason over review-request.json, start from decision-template.json, handle acquisition obligations first, rate candidates with agentEasyToPromote, and return one PromotionBatchDecision JSON. Decide promotion-ready slices independently before rejecting the remaining whole fallback.",
        decisionActions: ["promote", "reject", "delete", "rerecord"],
        afterPromotion:
          "Treat agentContractDelta from the apply result as an immediate patch to the working command contract. Use reusableCommand.command, or refresh SKILL.md/manifest.json, to reuse the acquired CLI skill.",
      },
    },
    cli: {
      binName: "instagram-com-cli",
      cliPath: path.join(binDir(), "instagram-com-cli"),
      cartographerCli,
      cgPath: path.join(binDir(), "cg"),
      binDirOnPath: true,
      shellCommand: `${cartographerCli} use ${domainAlias} --task "<task>"`,
      scriptedShellCommand: `${cartographerCli} use ${domainAlias} --task "<task>" < commands.txt`,
      execCommandPattern: `${cartographerCli} exec-command ${domainAlias} <command> [--task-id <taskId>] [--auto-chain] [--dry-run] [--confirm-write] [--key value]`,
      commandPattern: `${path.join(binDir(), "instagram-com-cli")} <command> [--task-id <taskId>] [--dry-run] [--confirm-write] [--key value]`,
      fallbackCommand: `${cartographerCli} pw ${domainAlias} --task-id <taskId> --intent <segment> snapshot`,
      scriptedFallbackCommand: `${cartographerCli} pw ${domainAlias} --task-id <taskId> goto https://www.instagram.com/direct/inbox/`,
      doctorCommand: `${cartographerCli} doctor ${domainAlias} --task-id <taskId>`,
      planCommand: `${cartographerCli} plan ${domainAlias} <processName>`,
      taskReviewCommand: `${cartographerCli} review-task ${domainAlias} --task-id <taskId>`,
      completeTaskCommand: `${cartographerCli} complete-task ${domainAlias} --task-id <taskId>`,
      taskSummaryCommand: `${cartographerCli} task-summary ${domainAlias} --task-id <taskId>`,
      reviewCommand: `${cartographerCli} review-task ${domainAlias} --task-id <taskId>`,
      cleanupCommand: `${cartographerCli} cleanup-recordings ${domainAlias} --confirm-delete`,
      analyzeSiteCommand: `${cartographerCli} analyze-site ${domainAlias}`,
      siteSummaryCommand: `${cartographerCli} site-summary ${domainAlias}`,
      siteNodeCommand: `${cartographerCli} site-node ${domainAlias} <node-id>`,
      siteActionsCommand: `${cartographerCli} site-actions ${domainAlias} <node-id>`,
    },
    commands: Object.values(catalog.processes)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((process) => toManifestCommand(process)),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return outputPath;
}

function toManifestCommand(process: ProcessTapeSummary) {
  return {
    name: slugifyName(process.name),
    processName: process.name,
    description: process.description,
    writesToPlatform: process.writesToPlatform,
    args: process.args,
    outputs: process.outputs || [],
    stateScope: process.stateScope,
    postconditions: process.postconditions || [],
    success: {
      actionFailuresFailCommand: true,
      postconditionsMustPass: Boolean(process.postconditions?.length),
      driftOnlyFailsCommand: false,
    },
    failureFields: [
      "failure",
      "preconditions.checks",
      "execution.actionFailures",
      "postconditions.checks",
      "drift.steps",
    ],
  };
}

function renderCommandSections(
  commands: ProcessTapeSummary[],
  domain: Domain,
  domainAlias: string,
  cartographerCli: string,
): string[] {
  if (!commands.length)
    return ["| none acquired yet | use fallback | no | none |"];
  const sections = [
    {
      title: "Global Commands",
      commands: commands.filter((command) => !command.stateScope),
    },
    {
      title: "Available In Inbox",
      commands: commands.filter((command) => scopeBucket(command) === "inbox"),
    },
    {
      title: "Available In DM Thread",
      commands: commands.filter(
        (command) => scopeBucket(command) === "dm_thread",
      ),
    },
    {
      title: "Available On Profile",
      commands: commands.filter(
        (command) => scopeBucket(command) === "profile",
      ),
    },
    {
      title: "Other Scoped Commands",
      commands: commands.filter((command) => scopeBucket(command) === "other"),
    },
  ];
  const lines: string[] = [];
  for (const section of sections) {
    if (!section.commands.length) continue;
    lines.push(`### ${section.title}`, "");
    lines.push("| Command | Use When | Writes | Outputs |");
    lines.push("|---|---|---:|---|");
    for (const process of section.commands) {
      const command = `${cartographerCli} exec-command ${domainAlias} ${slugifyName(process.name)}`;
      const writes = process.writesToPlatform ? "yes" : "no";
      const outputs = process.outputs?.length
        ? process.outputs.map((output) => output.name).join(", ")
        : "none";
      lines.push(
        `| \`${command}\` | ${tableCell(process.description || process.name)} | ${writes} | ${tableCell(outputs)} |`,
      );
    }
    lines.push("");
  }
  return lines.length
    ? lines.slice(0, -1)
    : ["| none acquired yet | use fallback | no | none |"];
}

function scopeBucket(
  process: ProcessTapeSummary,
): "inbox" | "dm_thread" | "profile" | "other" | "global" {
  if (!process.stateScope) return "global";
  const haystack = JSON.stringify(process.stateScope.preconditions || []);
  if (haystack.includes("/direct/t/")) return "dm_thread";
  if (haystack.includes("/direct/inbox")) return "inbox";
  if (haystack.includes("%username%") || haystack.includes("profile")) {
    return "profile";
  }
  return "other";
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function cartographerCommandPhrase(
  command: string,
  subcommand: string,
): string {
  return `${command} ${subcommand}`;
}
