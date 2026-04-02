import fs from "node:fs/promises";
import { launcherPathFor, readInstallState, resolveOptions, statePathFor } from "./lifecycle-lib.js";

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  const state = await readInstallState(options.installDir);

  const launcherPath = state?.launcherPath ?? launcherPathFor(options.binDir);
  const installDir = state?.installDir ?? options.installDir;
  const cacheDir = state?.cacheDir ?? options.cacheDir;
  const statePath = statePathFor(installDir);

  await safeRemoveFile(launcherPath);
  await safeRemoveDir(installDir);
  await safeRemoveFile(statePath);
  if (options.purgeCache) {
    await safeRemoveDir(cacheDir);
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          removed: {
            launcherPath,
            installDir,
            statePath,
            cacheDir: options.purgeCache ? cacheDir : null
          }
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`# Uninstall\n\n`);
  process.stdout.write(`- Removed launcher: \`${launcherPath}\`\n`);
  process.stdout.write(`- Removed install dir: \`${installDir}\`\n`);
  process.stdout.write(`- Removed state file: \`${statePath}\`\n`);
  process.stdout.write(
    options.purgeCache ? `- Purged cache dir: \`${cacheDir}\`\n` : `- Kept cache dir: \`${cacheDir}\` (use --purge-cache to remove)\n`
  );
}

async function safeRemoveFile(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // no-op
  }
}

async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // no-op
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[uninstall] failed: ${message}\n`);
  process.exitCode = 1;
});
