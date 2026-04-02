import { copyBundle, ensureBundleExists, readInstallState, resolveOptions, writeInstallState, writeLauncher } from "./lifecycle-lib.js";

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  const existing = await readInstallState(options.installDir);
  if (!existing) {
    throw new Error(`No install state found at ${options.installDir}. Run install first.`);
  }

  await ensureBundleExists(options.bundleFile);
  const bundlePath = await copyBundle(options.bundleFile, existing.installDir);

  const updated = {
    ...existing,
    installedAt: new Date().toISOString(),
    bundlePath
  };

  await writeLauncher(updated);
  await writeInstallState(updated);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, state: updated }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`# Upgrade\n\n`);
  process.stdout.write(`- Updated bundle at \`${bundlePath}\`\n`);
  process.stdout.write(`- Launcher refreshed at \`${updated.launcherPath}\`\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[upgrade] failed: ${message}\n`);
  process.exitCode = 1;
});
