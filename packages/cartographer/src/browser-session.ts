import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Stagehand } from "@browserbasehq/stagehand";
import type { Action } from "@browserbasehq/stagehand";
import type {
  ActOutcome,
  BrowserSession,
  BrowserSessionFactory,
  Domain,
  LaunchOptions,
  ObservedCandidate,
  RuntimeArgs,
} from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { actionToAtom } from "./state-identity.js";
import { browserProfileDir, evidenceDir } from "./paths.js";
import {
  isPlaywrightLocatorSelector,
  locatorForSelector,
} from "./playwright-selector.js";
import { waitForLoginIfNeeded } from "./login-wait.js";
import { getSiteConfig } from "./site-config.js";

export class StagehandBrowserSessionFactory implements BrowserSessionFactory {
  async launch(domain: Domain, options: LaunchOptions): Promise<BrowserSession> {
    const site = getSiteConfig(domain);
    await ensureDir(options.cacheDir);
    const profileDir =
      process.env.CARTOGRAPHER_BROWSER_PROFILE_DIR ||
      browserProfileDir(domain);
    await ensureDir(profileDir);
    const stagehand = new Stagehand({
      env: options.browser === "browserbase" ? "BROWSERBASE" : "LOCAL",
      verbose: 1,
      cacheDir: options.cacheDir,
      selfHeal: false,
      // Cartographer drives Stagehand via deterministic act(Action) replay
      // and never invokes act(string)/observe()/agent() on the runtime hot
      // path. noLlm:true skips API key loading entirely.
      noLlm: true,
      localBrowserLaunchOptions:
        options.browser === "local"
          ? {
              headless: options.headless,
              viewport: options.viewport,
              deviceScaleFactor: 1,
              userDataDir: profileDir,
              preserveUserDataDir: true,
            }
          : undefined,
    });
    await stagehand.init();
    const session = new StagehandBrowserSession(domain, stagehand);
    await session.goto(site.baseUrl);
    await waitForLoginIfNeeded(session, site.loginWaitLabel);
    return session;
  }

  async launchInstagram(options: LaunchOptions): Promise<BrowserSession> {
    return this.launch("instagram.com", options);
  }
}

export class StagehandBrowserSession implements BrowserSession {
  constructor(
    public readonly domain: Domain,
    private readonly stagehand: Stagehand,
  ) {}

  async currentUrl(): Promise<string> {
    return this.page().url();
  }

  async goto(url: string): Promise<void> {
    await this.page().goto(url);
  }

  async observe(instruction: string): Promise<ObservedCandidate[]> {
    const actions = await this.stagehand.observe(instruction);
    return actions.map((action, index) => ({
      id: `candidate_${index + 1}`,
      instruction,
      action,
      atom: actionToAtom(action, instruction, this.domain),
      risk: "unknown",
    }));
  }

  async act(
    candidate: ObservedCandidate,
    args?: RuntimeArgs,
  ): Promise<ActOutcome> {
    return await this.actRaw(candidate.action, args);
  }

  async actRaw(action: Action, args?: RuntimeArgs): Promise<ActOutcome> {
    if (isPlaywrightLocatorSelector(action.selector)) {
      return await this.actWithPlaywrightLocator(action);
    }

    const result = await this.stagehand.act(action, {
      variables: stringifyRuntimeArgs(args),
    });
    return {
      success: result.success,
      message: result.message,
      actions: result.actions || [],
    };
  }

  async exists(selector: string): Promise<boolean> {
    return (await locatorForSelector(this.page() as any, selector).count()) > 0;
  }

  async readText(selector = "body"): Promise<string> {
    const locator = locatorForSelector(this.page() as any, selector);
    return await locator.innerText();
  }

  async isVisible(selector: string): Promise<boolean> {
    const locator = locatorForSelector(this.page() as any, selector).first();
    return await locator.isVisible();
  }

  async isEnabled(selector: string): Promise<boolean> {
    const locator = locatorForSelector(this.page() as any, selector).first();
    return await locator.isEnabled();
  }

  async scrollIntoView(selector: string): Promise<void> {
    const locator = locatorForSelector(this.page() as any, selector).first();
    await locator.scrollIntoViewIfNeeded();
  }

  async wait(milliseconds: number): Promise<void> {
    await this.page().waitForTimeout(milliseconds);
  }

  async waitForSettle(): Promise<void> {
    await this.page().waitForLoadState("networkidle").catch(() => {});
    await (this.page() as any)
      .waitForFunction(() => document.readyState === "complete", undefined, {
        timeout: 2000,
      })
      .catch(() => {});
    await this.page().waitForTimeout(100);
  }

  async screenshot(label: string): Promise<string> {
    const dir = evidenceDir(this.domain);
    await ensureDir(dir);
    const safeLabel = label
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    const filePath = path.join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}.png`,
    );
    const buffer = await this.page().screenshot();
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async waitForUser(label: string): Promise<void> {
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(`${label} Press Enter to continue... `);
    } finally {
      rl.close();
    }
  }

  async close(): Promise<void> {
    await this.stagehand.close();
  }

  private page() {
    return this.stagehand.context.pages()[0];
  }

  private async actWithPlaywrightLocator(action: Action): Promise<ActOutcome> {
    const method = action.method;
    const locator = locatorForSelector(this.page() as any, action.selector).first();
    const actionArgs = action.arguments || [];
    try {
      if (method === "click") {
        await locator.click();
      } else if (method === "fill") {
        await locator.fill(actionArgs[0] || "");
      } else if (method === "press") {
        if (!locator.press) {
          return {
            success: false,
            message:
              "Playwright locator replay does not support press in this runtime.",
            actions: [],
          };
        }
        await locator.press(actionArgs[0] || "");
      } else {
        return {
          success: false,
          message: `Playwright locator replay does not support method: ${method}`,
          actions: [],
        };
      }

      return {
        success: true,
        message: `Action [${method}] performed successfully on selector: ${action.selector}`,
        actions: [action],
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        actions: [],
      };
    }
  }
}

function stringifyRuntimeArgs(
  args?: RuntimeArgs,
): Record<string, string> | undefined {
  if (!args) return undefined;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, String(value)]),
  );
}
