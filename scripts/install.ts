import fs from "node:fs/promises";
import {
  copyBundle,
  ensureBundleExists,
  launcherPathFor,
  readInstallState,
  renderMcpConfigSnippet,
  resolveOptions,
  writeInstallState,
  writeLauncher,
  type InstallState
} from "./lifecycle-lib.js";

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  await ensureBundleExists(options.bundleFile);

  const existing = await readInstallState(options.installDir);
  const bundlePath = await copyBundle(options.bundleFile, options.installDir);
  const launcherPath = launcherPathFor(options.binDir);

  const state: InstallState = {
    installedAt: new Date().toISOString(),
    installDir: options.installDir,
    binDir: options.binDir,
    cacheDir: options.cacheDir,
    runtime: options.runtime,
    storage: options.storage,
    sqlitePath: options.sqlitePath,
    launcherPath,
    bundlePath
  };

  await writeLauncher(state);
  await writeInstallState(state);
  await fs.mkdir(options.cacheDir, { recursive: true });

  const snippet = renderMcpConfigSnippet(state);
  if (options.writeConfig) {
    const configPath = options.configPath ?? `${options.installDir}/marten-docs-mcp.json`;
    await fs.writeFile(configPath, `${snippet}\n`, "utf8");
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          updated: existing !== null,
          state,
          mcpConfigSnippet: snippet
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`${existing ? "Updated" : "Installed"} marten-docs-mcp at \`${launcherPath}\`\n\n`);
  process.stdout.write(`${snippet}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[install] failed: ${message}\n`);
  process.exitCode = 1;
});
