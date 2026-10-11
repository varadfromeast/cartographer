import lockfile from "proper-lockfile";
import type { Domain } from "./contracts.js";
import { ensureDir } from "./fs-json.js";
import { browserProfileDir } from "./paths.js";

export async function withBrowserProfileLock<T>(
  domain: Domain,
  profile: string,
  operation: () => Promise<T>,
): Promise<T> {
  const profileDir = browserProfileDir(domain, profile);
  await ensureDir(profileDir);
  const release = await lockfile.lock(profileDir, {
    stale: 60_000,
    update: 5_000,
    retries: {
      retries: 120,
      minTimeout: 250,
      maxTimeout: 2_000,
      factor: 1.2,
    },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
