import type { Domain } from "../contracts.js";
import { getSiteConfig } from "../site-config.js";
import type { CandidateEdge } from "./post-capture.js";
import type { ExplorationGoalName } from "./harness-contracts.js";

export interface ExplorationSiteAdapter {
  domain: Domain;
  defaultMaxNavigationEdgesPerSurface: number;
  resolveGoalUrl(goal?: ExplorationGoalName): string;
  isCrawlableUrl(url: string): boolean;
  routePriority(url: string, edgePriority: number): number;
  edgePriority(edge: CandidateEdge, currentSurfaceUrl: string): number;
}

const DEFAULT_MAX_NAVIGATION_EDGES_PER_SURFACE = 12;

export function getExplorationSiteAdapter(
  domain: Domain,
): ExplorationSiteAdapter {
  if (domain === "instagram.com") return instagramAdapter;
  if (domain === "linkedin.com") return linkedinAdapter;
  if (domain === "x.com") return xAdapter;
  if (domain === "ycombinator.com") return ycombinatorAdapter;
  return defaultAdapterFor(domain);
}

function defaultAdapterFor(domain: Domain): ExplorationSiteAdapter {
  return {
    domain,
    defaultMaxNavigationEdgesPerSurface:
      DEFAULT_MAX_NAVIGATION_EDGES_PER_SURFACE,
    resolveGoalUrl: () => getSiteConfig(domain).baseUrl,
    isCrawlableUrl: () => true,
    routePriority: (_url, edgePriority) => -edgePriority,
    edgePriority: (edge) => edge.priority,
  };
}

const instagramAdapter: ExplorationSiteAdapter = {
  domain: "instagram.com",
  defaultMaxNavigationEdgesPerSurface: DEFAULT_MAX_NAVIGATION_EDGES_PER_SURFACE,
  resolveGoalUrl(goal) {
    const urls: Partial<Record<ExplorationGoalName, string>> = {
      instagram_home_feed: "https://www.instagram.com/",
      instagram_search: "https://www.instagram.com/explore/search/",
      instagram_notifications: "https://www.instagram.com/notifications/",
      instagram_dm_inbox: "https://www.instagram.com/direct/inbox/",
      instagram_dm_composer: "https://www.instagram.com/direct/inbox/",
    };
    return urlForGoal("instagram.com", goal, urls);
  },
  isCrawlableUrl(urlValue) {
    const url = new URL(urlValue);
    if (
      /^\/(accounts|oauth|developer|api|ajax|emails|challenge)\b/.test(
        url.pathname,
      )
    ) {
      return false;
    }
    return !/\b(logout|remove|delete|block|report)\b/i.test(url.pathname);
  },
  routePriority: (_url, edgePriority) => -edgePriority,
  edgePriority: (edge) => edge.priority,
};

const linkedinAdapter: ExplorationSiteAdapter = {
  domain: "linkedin.com",
  defaultMaxNavigationEdgesPerSurface: DEFAULT_MAX_NAVIGATION_EDGES_PER_SURFACE,
  resolveGoalUrl(goal) {
    const urls: Partial<Record<ExplorationGoalName, string>> = {
      linkedin_home_feed: "https://www.linkedin.com/feed/",
      linkedin_search_results:
        "https://www.linkedin.com/search/results/all/?keywords=cartographer",
      linkedin_messaging: "https://www.linkedin.com/messaging/",
      linkedin_notifications: "https://www.linkedin.com/notifications/",
      linkedin_my_network: "https://www.linkedin.com/mynetwork/",
    };
    return urlForGoal("linkedin.com", goal, urls);
  },
  isCrawlableUrl(urlValue) {
    const url = new URL(urlValue);
    return !/\/(logout|delete|remove|block|report)\b/i.test(url.pathname);
  },
  routePriority: (_url, edgePriority) => -edgePriority,
  edgePriority: (edge) => edge.priority,
};

const xAdapter: ExplorationSiteAdapter = {
  domain: "x.com",
  defaultMaxNavigationEdgesPerSurface: DEFAULT_MAX_NAVIGATION_EDGES_PER_SURFACE,
  resolveGoalUrl(goal) {
    const urls: Partial<Record<ExplorationGoalName, string>> = {
      x_home: "https://x.com/home",
      x_explore: "https://x.com/explore",
      x_notifications: "https://x.com/notifications",
      x_messages: "https://x.com/messages",
    };
    return urlForGoal("x.com", goal, urls);
  },
  isCrawlableUrl(urlValue) {
    const url = new URL(urlValue);
    if (/\/(logout|delete|remove|block|report)\b/i.test(url.pathname)) {
      return false;
    }
    return !/^\/(i\/flow|i\/keyboard_shortcuts|i\/jf|i\/premium|settings|account|tos|privacy)\b/i.test(
      url.pathname,
    );
  },
  routePriority: (_url, edgePriority) => -edgePriority,
  edgePriority: (edge) => edge.priority,
};

const ycombinatorAdapter: ExplorationSiteAdapter = {
  domain: "ycombinator.com",
  defaultMaxNavigationEdgesPerSurface: 24,
  resolveGoalUrl(goal) {
    const urls: Partial<Record<ExplorationGoalName, string>> = {
      yc_home: "https://www.ycombinator.com/",
      yc_about: "https://www.ycombinator.com/about",
      yc_companies: "https://www.ycombinator.com/companies",
      yc_jobs: "https://www.ycombinator.com/jobs",
      yc_apply: "https://www.ycombinator.com/apply",
      yc_blog: "https://www.ycombinator.com/blog",
    };
    return urlForGoal("ycombinator.com", goal, urls);
  },
  isCrawlableUrl(urlValue) {
    const url = new URL(urlValue);
    if (
      url.hostname !== "www.ycombinator.com" &&
      url.hostname !== "ycombinator.com"
    ) {
      return false;
    }
    if (/\/(sign-in|signin|login|logout|admin)\b/i.test(url.pathname)) {
      return false;
    }
    return !/\.(?:pdf|png|jpe?g|gif|svg|webp|zip)$/i.test(url.pathname);
  },
  routePriority(urlValue, edgePriority) {
    const url = new URL(urlValue);
    const routePath = url.pathname.replace(/\/$/, "") || "/";
    const canonicalOrder = [
      "/jobs",
      "/library",
      "/about",
      "/companies",
      "/partners",
      "/apply",
      "/blog",
      "/launches",
      "/cofounder-matching",
      "/investors",
      "/demoday",
      "/documents",
      "/faq",
      "/contact",
      "/press",
      "/security",
      "/handshake",
    ];
    const canonicalIndex = canonicalOrder.indexOf(routePath);
    if (canonicalIndex >= 0) return canonicalIndex - edgePriority / 1000;
    if (/^\/library\/search/.test(routePath)) return 30 - edgePriority / 1000;
    if (/^\/library\//.test(routePath)) return 40 - edgePriority / 1000;
    if (/^\/companies\/[^/]+/.test(routePath)) return 50 - edgePriority / 1000;
    if (/^\/jobs\/[^/]+/.test(routePath)) return 60 - edgePriority / 1000;
    if (/^\/people\/[^/]+/.test(routePath)) return 70 - edgePriority / 1000;
    return 80 - edgePriority / 1000;
  },
  edgePriority: (edge) => edge.priority,
};

function urlForGoal(
  domain: Domain,
  goal: ExplorationGoalName | undefined,
  urls: Partial<Record<ExplorationGoalName, string>>,
): string {
  if (!goal) return getSiteConfig(domain).baseUrl;
  const url = urls[goal];
  if (url) return url;
  throw new Error(`Exploration goal ${goal} is not defined for ${domain}`);
}
