import type { SiteConfig } from "../../site-config.js";

export const xConfig: SiteConfig = {
  domain: "x.com",
  baseUrl: "https://x.com/home",
  loginWaitLabel: "X login screen detected",
  knownInterrupts: [
    { name: "X cookie consent", dismissSelector: "text='Accept all cookies'" },
    {
      name: "X cookie consent",
      dismissSelector: "text='Refuse non-essential cookies'",
    },
  ],
};
