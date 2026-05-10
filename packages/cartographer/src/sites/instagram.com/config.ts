import type { SiteConfig } from "../../site-config.js";

export const instagramConfig: SiteConfig = {
  domain: "instagram.com",
  baseUrl: "https://www.instagram.com/",
  loginWaitLabel: "Instagram login screen detected",
  knownInterrupts: [
    { name: "Instagram Notifications", dismissSelector: "text='Not Now'" },
    {
      name: "Instagram Cookie Consent",
      dismissSelector: "button:has-text('Decline optional cookies')",
    },
    { name: "Instagram App Promotion", dismissSelector: "button:has-text('Not Now')" },
  ],
};
