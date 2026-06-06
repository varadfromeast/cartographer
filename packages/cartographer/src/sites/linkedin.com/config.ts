import type { SiteConfig } from "../../site-config.js";

export const linkedinConfig: SiteConfig = {
  domain: "linkedin.com",
  baseUrl: "https://www.linkedin.com/",
  loginWaitLabel: "LinkedIn login screen detected",
  knownInterrupts: [
    {
      name: "LinkedIn Cookie Consent",
      dismissSelector: "button:has-text('Accept')",
    },
    {
      name: "LinkedIn App Promotion",
      dismissSelector: "button:has-text('Dismiss')",
    },
  ],
};
