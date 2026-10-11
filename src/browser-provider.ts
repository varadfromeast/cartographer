import { chromium } from "playwright";

export function cartographerBrowserExecutablePath(): string {
  return process.env.CARTOGRAPHER_CHROME_PATH || chromium.executablePath();
}
