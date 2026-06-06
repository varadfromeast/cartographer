import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Page } from "playwright";
import type { BrowserSession } from "./contracts.js";

const LOGIN_URL_PARTS = [
  "/accounts/login",
  "/accounts/onetap",
  "/login",
  "/checkpoint",
  "/uas/login",
];
const LOGIN_SELECTORS = [
  'input[name="username"]',
  'input[name="password"]',
  'input[type="password"]',
  'input[name="session_key"]',
  'input[name="session_password"]',
  'form[action*="/accounts/login"]',
  'form[action*="login"]',
];

export async function waitForLoginIfNeeded(
  session: BrowserSession,
  label = "Login screen detected",
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await isBrowserSessionLoginScreen(session))) return;
    await waitForUserLogin(label);
  }
}

export async function waitForPageLoginIfNeeded(
  page: Page,
  label = "Login screen detected",
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await isPageLoginScreen(page))) return;
    await waitForUserLogin(label);
  }
}

async function isBrowserSessionLoginScreen(
  session: BrowserSession,
): Promise<boolean> {
  const url = await session.currentUrl();
  if (isLoginUrl(url)) return true;
  for (const selector of LOGIN_SELECTORS) {
    try {
      if (await session.exists(selector)) return true;
    } catch {
      // Selector support differs between session implementations.
    }
  }
  return false;
}

async function isPageLoginScreen(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) return true;
  for (const selector of LOGIN_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch {
      // Ignore transient DOM/selector failures while detecting login state.
    }
  }
  return false;
}

function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PARTS.some((part) => url.includes(part));
}

async function waitForUserLogin(label: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(
      `${label}. Complete login in the open browser, then press Enter to continue... `,
    );
  } finally {
    rl.close();
  }
}
