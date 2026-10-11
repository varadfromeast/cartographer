import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Domain, TaskId } from "../contracts.js";
import { readJsonFile, writeJsonFile } from "../fs-json.js";
import { browserSessionPath } from "../paths.js";
import { withBrowserProfileLock } from "../profile-lock.js";
import { getSiteConfig } from "../site-config.js";
import {
  activeTaskIdsFor,
  closeTaskBrowser,
  connectOrStartTaskBrowser,
  normalizeTaskBrowserRecord,
  type TaskBrowserRecord,
} from "../task-browser.js";
import type { ExplorationGoalName } from "./harness-contracts.js";

export interface SavedSessionStatus {
  schemaVersion: 1;
  domain: Domain;
  profile: string;
  openedBrowser: boolean;
  leftOpen: boolean;
  cdpAlive: boolean;
  authenticated: boolean;
  loginLike: boolean;
  url?: string;
  title?: string;
  authCookieNames: string[];
  expectedAuthCookieNames: string[];
  browserSessionPath: string;
  cdpUrl?: string;
  activeTaskIds?: TaskId[];
  activeTaskLeaseCount?: number;
  checkedAt: string;
  loginInstructions?: string;
}

export async function checkSavedSessionStatus(input: {
  domain: Domain;
  goal?: ExplorationGoalName;
  profile?: string;
  open?: boolean;
  leaveOpen?: boolean;
}): Promise<SavedSessionStatus> {
  const profile = input.profile || "default";
  return withBrowserProfileLock(input.domain, profile, async () =>
    checkSavedSessionStatusLocked(input, profile),
  );
}

async function checkSavedSessionStatusLocked(
  input: {
    domain: Domain;
    goal?: ExplorationGoalName;
    profile?: string;
    open?: boolean;
    leaveOpen?: boolean;
  },
  profile: string,
): Promise<SavedSessionStatus> {
  const sessionPath = browserSessionPath(input.domain, profile);
  let record = await readJsonFile<TaskBrowserRecord>(sessionPath);
  if (record) {
    const normalized = normalizeTaskBrowserRecord(record);
    if (JSON.stringify(normalized) !== JSON.stringify(record)) {
      await writeJsonFile(sessionPath, {
        ...normalized,
        updatedAt: new Date().toISOString(),
      });
      record = { ...normalized, updatedAt: new Date().toISOString() };
    } else {
      record = normalized;
    }
  }
  const taskId = `session-status-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let openedBrowser = false;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdpUrl = record?.cdpUrl;
  let cdpAlive = cdpUrl ? await isCdpAlive(cdpUrl) : false;

  if (cdpAlive && cdpUrl) {
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages()[0] || (await context.newPage());
  } else if (input.open) {
    const connection = await connectOrStartTaskBrowser(input.domain, taskId, profile);
    openedBrowser = true;
    browser = connection.browser;
    context = connection.context;
    page = connection.page;
    cdpUrl = connection.cdpUrl;
    cdpAlive = true;
  }

  let url: string | undefined;
  let title: string | undefined;
  let authCookieNames: string[] = [];
  let loginLike = false;
  if (page && context) {
    await page.goto(goalUrlForSessionStatus(input.domain, input.goal), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    url = page.url();
    title = await page.title().catch((): undefined => undefined);
    const cookies = await context.cookies(getSiteConfig(input.domain).baseUrl);
    const cookieNames = cookies.map((cookie) => cookie.name);
    authCookieNames = cookieNames.filter((name) =>
      expectedAuthCookieNames(input.domain).includes(name),
    );
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5000 })
      .catch(() => "");
    loginLike = loginTextFor(input.domain).test(bodyText.replace(/\s+/g, " "));
  }

  const primaryAuthNames = primaryAuthCookieNames(input.domain);
  const authenticated = primaryAuthNames.length
    ? authCookieNames.some((name) => primaryAuthNames.includes(name))
    : Boolean(page);
  const leftOpen = Boolean(input.leaveOpen && page && context);
  if (browser && !leftOpen) {
    if (openedBrowser) {
      await closeTaskBrowser(input.domain, taskId, profile);
    } else {
      await browser.close().catch(() => {});
    }
  }

  return {
    schemaVersion: 1,
    domain: input.domain,
    profile,
    openedBrowser,
    leftOpen,
    cdpAlive,
    authenticated,
    loginLike,
    url,
    title,
    authCookieNames,
    expectedAuthCookieNames: expectedAuthCookieNames(input.domain),
    browserSessionPath: sessionPath,
    cdpUrl,
    activeTaskIds: activeTaskIdsFor(record),
    activeTaskLeaseCount: record?.activeTaskLeases?.length || 0,
    checkedAt: new Date().toISOString(),
    loginInstructions:
      !authenticated && leftOpen
        ? `Complete login in the opened ${input.domain} browser profile, then rerun session-status.`
        : undefined,
  };
}

async function isCdpAlive(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function expectedAuthCookieNames(domain: Domain): string[] {
  if (domain === "instagram.com")
    return ["sessionid", "ds_user_id", "csrftoken", "ig_did", "mid"];
  if (domain === "linkedin.com")
    return ["li_at", "JSESSIONID", "bcookie", "bscookie", "lidc", "liap"];
  if (domain === "ycombinator.com") return [];
  return ["auth_token", "ct0", "twid"];
}

function primaryAuthCookieNames(domain: Domain): string[] {
  if (domain === "instagram.com") return ["sessionid", "ds_user_id"];
  if (domain === "linkedin.com") return ["li_at"];
  if (domain === "ycombinator.com") return [];
  return ["auth_token"];
}

function loginTextFor(domain: Domain): RegExp {
  if (domain === "instagram.com")
    return /\b(log in|sign in|password|phone number|username)\b/i;
  if (domain === "linkedin.com")
    return /\b(sign in|join now|email or phone|password)\b/i;
  if (domain === "ycombinator.com")
    return /\b(sign in|log in|password|email address)\b/i;
  return /\b(email or username|continue with phone|sign in)\b/i;
}

function goalUrlForSessionStatus(
  domain: Domain,
  goal?: ExplorationGoalName,
): string {
  if (domain === "instagram.com") {
    if (goal === "instagram_search") return "https://www.instagram.com/explore/search/";
    if (goal === "instagram_notifications")
      return "https://www.instagram.com/notifications/";
    if (goal === "instagram_dm_inbox" || goal === "instagram_dm_composer")
      return "https://www.instagram.com/direct/inbox/";
    return "https://www.instagram.com/";
  }
  if (domain === "linkedin.com") {
    if (goal === "linkedin_search_results")
      return "https://www.linkedin.com/search/results/all/?keywords=cartographer";
    if (goal === "linkedin_messaging") return "https://www.linkedin.com/messaging/";
    if (goal === "linkedin_notifications")
      return "https://www.linkedin.com/notifications/";
    if (goal === "linkedin_my_network") return "https://www.linkedin.com/mynetwork/";
    return "https://www.linkedin.com/feed/";
  }
  if (domain === "ycombinator.com") {
    if (goal === "yc_about") return "https://www.ycombinator.com/about";
    if (goal === "yc_companies") return "https://www.ycombinator.com/companies";
    if (goal === "yc_jobs") return "https://www.ycombinator.com/jobs";
    if (goal === "yc_apply") return "https://www.ycombinator.com/apply";
    if (goal === "yc_blog") return "https://www.ycombinator.com/blog";
    return "https://www.ycombinator.com/";
  }
  if (goal === "x_explore") return "https://x.com/explore";
  if (goal === "x_notifications") return "https://x.com/notifications";
  if (goal === "x_messages") return "https://x.com/messages";
  return "https://x.com/home";
}
