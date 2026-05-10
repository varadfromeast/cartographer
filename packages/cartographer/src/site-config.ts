import type { Domain, InterruptHandler } from "./contracts.js";
import { instagramConfig } from "./sites/instagram.com/config.js";

export interface SiteConfig {
  domain: Domain;
  baseUrl: string;
  loginWaitLabel: string;
  knownInterrupts: InterruptHandler[];
}

export const SITES_CONFIG: Record<Domain, SiteConfig> = {
  "instagram.com": instagramConfig,
};

export function getSiteConfig(domain: Domain): SiteConfig {
  return SITES_CONFIG[domain];
}
