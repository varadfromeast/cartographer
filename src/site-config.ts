import type { Domain, InterruptHandler } from "./contracts.js";
import { instagramConfig } from "./sites/instagram.com/config.js";
import { linkedinConfig } from "./sites/linkedin.com/config.js";
import { xConfig } from "./sites/x.com/config.js";
import { ycombinatorConfig } from "./sites/ycombinator.com/config.js";

export interface SiteConfig {
  domain: Domain;
  baseUrl: string;
  loginWaitLabel: string;
  knownInterrupts: InterruptHandler[];
}

export const SITES_CONFIG: Record<Domain, SiteConfig> = {
  "instagram.com": instagramConfig,
  "linkedin.com": linkedinConfig,
  "x.com": xConfig,
  "ycombinator.com": ycombinatorConfig,
};

export function getSiteConfig(domain: Domain): SiteConfig {
  return SITES_CONFIG[domain];
}
