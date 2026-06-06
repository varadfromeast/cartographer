import os from "node:os";
import path from "node:path";
import type {
  Domain,
  ProcessName,
  TaskId,
  TaskSegmentId,
} from "./contracts.js";

export function cartographerHome(): string {
  return (
    process.env.CARTOGRAPHER_HOME || path.join(os.homedir(), ".cartographer")
  );
}

export function siteDir(domain: Domain): string {
  return path.join(cartographerHome(), "sites", domain);
}

export function tapeDir(domain: Domain): string {
  return path.join(siteDir(domain), "tapes");
}

export function processTapePath(domain: Domain, name: ProcessName): string {
  return path.join(tapeDir(domain), `${slugifyName(name)}.json`);
}

export function catalogPath(domain: Domain): string {
  return path.join(siteDir(domain), "catalog.json");
}

export function stateActionCacheDir(domain: Domain): string {
  return path.join(siteDir(domain), "state-action-cache");
}

export function browserProfilesDir(domain: Domain): string {
  return path.join(siteDir(domain), "browser-profiles");
}

export function browserProfileDir(domain: Domain, profile = "default"): string {
  return path.join(
    browserProfilesDir(domain),
    slugifyName(profile) || "default",
  );
}

export function browserSessionPath(
  domain: Domain,
  profile = "default",
): string {
  return path.join(browserProfileDir(domain, profile), "browser-session.json");
}

export function evidenceDir(domain: Domain): string {
  return path.join(siteDir(domain), "evidence");
}

export function fallbackDir(domain: Domain): string {
  return path.join(siteDir(domain), "fallbacks");
}

export function tasksDir(domain: Domain): string {
  return path.join(siteDir(domain), "tasks");
}

export function taskDir(domain: Domain, taskId: TaskId): string {
  return path.join(tasksDir(domain), slugifyName(taskId));
}

export function taskJsonPath(domain: Domain, taskId: TaskId): string {
  return path.join(taskDir(domain, taskId), "task.json");
}

export function taskMarkdownPath(domain: Domain, taskId: TaskId): string {
  return path.join(taskDir(domain, taskId), "TASK.md");
}

export function taskPromotionReviewPath(
  domain: Domain,
  taskId: TaskId,
): string {
  return path.join(taskDir(domain, taskId), "REVIEW.md");
}

export function taskPromotionReviewRequestPath(
  domain: Domain,
  taskId: TaskId,
): string {
  return path.join(taskDir(domain, taskId), "review-request.json");
}

export function taskPromotionDecisionSchemaPath(
  domain: Domain,
  taskId: TaskId,
): string {
  return path.join(taskDir(domain, taskId), "decision-schema.json");
}

export function taskPromotionDecisionTemplatePath(
  domain: Domain,
  taskId: TaskId,
): string {
  return path.join(taskDir(domain, taskId), "decision-template.json");
}

export function taskSegmentsDir(domain: Domain, taskId: TaskId): string {
  return path.join(taskDir(domain, taskId), "segments");
}

export function taskSegmentDir(
  domain: Domain,
  taskId: TaskId,
  segmentId: TaskSegmentId,
): string {
  return path.join(taskSegmentsDir(domain, taskId), slugifyName(segmentId));
}

export function taskSegmentJsonPath(
  domain: Domain,
  taskId: TaskId,
  segmentId: TaskSegmentId,
): string {
  return path.join(taskSegmentDir(domain, taskId, segmentId), "segment.json");
}

export function taskSegmentMarkdownPath(
  domain: Domain,
  taskId: TaskId,
  segmentId: TaskSegmentId,
): string {
  return path.join(taskSegmentDir(domain, taskId, segmentId), "SEGMENT.md");
}

export function taskSegmentEventJournalPath(
  domain: Domain,
  taskId: TaskId,
  segmentId: TaskSegmentId,
): string {
  return path.join(taskSegmentDir(domain, taskId, segmentId), "events.jsonl");
}

export function taskSegmentEvidenceDir(
  domain: Domain,
  taskId: TaskId,
  segmentId: TaskSegmentId,
): string {
  return path.join(taskSegmentDir(domain, taskId, segmentId), "evidence");
}

export function fallbackTapePath(domain: Domain, id: string): string {
  return path.join(fallbackDir(domain), `${slugifyName(id)}.json`);
}

export function fallbackTapeDir(domain: Domain, id: string): string {
  return path.join(fallbackDir(domain), slugifyName(id));
}

export function fallbackTapeJsonPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "fallback.json");
}

export function fallbackReviewPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "REVIEW.md");
}

export function fallbackReviewRequestPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "review-request.json");
}

export function fallbackDecisionSchemaPath(domain: Domain, id: string): string {
  return path.join(fallbackTapeDir(domain, id), "decision-schema.json");
}

export function fallbackDecisionTemplatePath(
  domain: Domain,
  id: string,
): string {
  return path.join(fallbackTapeDir(domain, id), "decision-template.json");
}

export function promotionDir(domain: Domain): string {
  return path.join(siteDir(domain), "promotions");
}

export function recordingDirs(domain: Domain): string[] {
  return [
    fallbackDir(domain),
    tasksDir(domain),
    evidenceDir(domain),
    visualReviewDir(domain),
    promotionDir(domain),
  ];
}

export function promotionProposalPath(domain: Domain, id: string): string {
  return path.join(promotionDir(domain), `${slugifyName(id)}.json`);
}

export function skillDir(domain: Domain, name: ProcessName): string {
  return path.join(siteDir(domain), "skills", slugifyName(name));
}

export function skillProcessPath(domain: Domain, name: ProcessName): string {
  return path.join(skillDir(domain, name), "process.json");
}

export function skillReadmePath(domain: Domain, name: ProcessName): string {
  return path.join(skillDir(domain, name), "SKILL.md");
}

export function skillPath(domain: Domain): string {
  return path.join(siteDir(domain), "SKILL.md");
}

export function manifestPath(domain: Domain): string {
  return path.join(siteDir(domain), "manifest.json");
}

export function siteGraphJsonPath(domain: Domain): string {
  return path.join(siteDir(domain), "site-graph.json");
}

export function siteGraphMarkdownPath(domain: Domain): string {
  return path.join(siteDir(domain), "site-graph.md");
}

export function surfacePacketDir(domain: Domain): string {
  return path.join(siteDir(domain), "surfaces");
}

export function surfacePacketIndexPath(domain: Domain): string {
  return path.join(surfacePacketDir(domain), "index.json");
}

export function surfacePacketPath(domain: Domain, nodeId: string): string {
  return path.join(surfacePacketDir(domain), `${slugifyName(nodeId)}.json`);
}

export function visualReviewDir(domain: Domain): string {
  return path.join(siteDir(domain), "visual-reviews");
}

export function visualReviewPath(domain: Domain, id: string): string {
  return path.join(visualReviewDir(domain), `${slugifyName(id)}.json`);
}

export function auditPath(domain: Domain): string {
  return path.join(siteDir(domain), "audit.jsonl");
}

export function binDir(): string {
  return path.join(cartographerHome(), "bin");
}

export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
