import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimeChoice = "auto" | "bun" | "node";
export type StorageChoice = "auto" | "sqlite" | "json";

export interface LifecycleOptions {
  installDir: string;
  binDir: string;
  cacheDir: string;
  runtime: RuntimeChoice;
  storage: StorageChoice;
  sqlitePath: string;
  bundleFile: string;
  writeConfig: boolean;
  configPath: string | null;
  json: boolean;
  purgeCache: boolean;
}

export interface InstallState {
  installedAt: string;
  installDir: string;
  binDir: string;
  cacheDir: string;
  runtime: RuntimeChoice;
  storage: StorageChoice;
  sqlitePath: string;
  launcherPath: string;
  bundlePath: string;
}

const APP_NAME = "marten-docs-mcp";
const DEFAULT_LAUNCHER_NAME = "marten-docs-mcp";

export function resolveOptions(argv: string[]): LifecycleOptions {
  const args = parseArgs(argv);
  const installDir = path.resolve(args.installDir ?? defaultInstallDir());
  const binDir = path.resolve(args.binDir ?? defaultBinDir());
  const cacheDir = path.resolve(args.cacheDir ?? defaultCacheDir());
  const runtime = (args.runtime ?? "auto") as RuntimeChoice;
  const storage = (args.storage ?? "auto") as StorageChoice;
  const sqlitePath = path.resolve(args.sqlitePath ?? path.join(cacheDir, "cache.db"));

  return {
    installDir,
    binDir,
    cacheDir,
    runtime,
    storage,
    sqlitePath,
    bundleFile: path.resolve(args.bundleFile ?? path.join(process.cwd(), "bundle", "index.js")),
    writeConfig: args.writeConfig,
    configPath: args.configPath ?? null,
    json: args.json,
    purgeCache: args.purgeCache
  };
}

function defaultInstallDir(): string {
  return process.env.MARTEN_MCP_INSTALL_DIR ?? path.join(xdgDataHome(), APP_NAME);
}

function defaultCacheDir(): string {
  return process.env.MARTEN_MCP_CACHE_DIR ?? path.join(xdgCacheHome(), APP_NAME);
}

function defaultBinDir(): string {
  if (process.env.MARTEN_MCP_BIN_DIR) {
    return process.env.MARTEN_MCP_BIN_DIR;
  }

  if (process.env.XDG_BIN_DIR) {
    return process.env.XDG_BIN_DIR;
  }

  const homeBin = path.join(os.homedir(), "bin");
  if (existsSync(homeBin)) {
    return homeBin;
  }

  try {
    mkdirSync(homeBin, { recursive: true });
    return homeBin;
  } catch {
    return path.join(os.homedir(), ".local", "bin");
  }
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

function xdgCacheHome(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export function parseArgs(argv: string[]): {
  installDir?: string;
  binDir?: string;
  cacheDir?: string;
  runtime?: string;
  storage?: string;
  sqlitePath?: string;
  bundleFile?: string;
  configPath?: string;
  writeConfig: boolean;
  json: boolean;
  purgeCache: boolean;
} {
  const out: ReturnType<typeof parseArgs> = {
    writeConfig: false,
    json: false,
    purgeCache: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--install-dir" && next) {
      out.installDir = next;
      i += 1;
      continue;
    }
    if (arg === "--bin-dir" && next) {
      out.binDir = next;
      i += 1;
      continue;
    }
    if (arg === "--cache-dir" && next) {
      out.cacheDir = next;
      i += 1;
      continue;
    }
    if (arg === "--runtime" && next) {
      out.runtime = next;
      i += 1;
      continue;
    }
    if (arg === "--storage" && next) {
      out.storage = next;
      i += 1;
      continue;
    }
    if (arg === "--sqlite-path" && next) {
      out.sqlitePath = next;
      i += 1;
      continue;
    }
    if (arg === "--bundle-file" && next) {
      out.bundleFile = next;
      i += 1;
      continue;
    }
    if (arg === "--config-path" && next) {
      out.configPath = next;
      i += 1;
      continue;
    }
    if (arg === "--write-config") {
      out.writeConfig = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--purge-cache") {
      out.purgeCache = true;
      continue;
    }
  }

  return out;
}

export function launcherPathFor(binDir: string): string {
  return path.join(binDir, DEFAULT_LAUNCHER_NAME);
}

export function statePathFor(installDir: string): string {
  return path.join(installDir, "install-state.json");
}

export async function writeInstallState(state: InstallState): Promise<void> {
  await fs.mkdir(state.installDir, { recursive: true });
  await fs.writeFile(statePathFor(state.installDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readInstallState(installDir: string): Promise<InstallState | null> {
  try {
    const json = await fs.readFile(statePathFor(installDir), "utf8");
    return JSON.parse(json) as InstallState;
  } catch {
    return null;
  }
}

export function renderMcpConfigSnippet(state: InstallState): string {
  return JSON.stringify(
    {
      mcpServers: {
        "marten-docs": {
          command: state.launcherPath,
          args: [],
          env: {
            MARTEN_MCP_CACHE_DIR: state.cacheDir,
            MARTEN_MCP_STORAGE_MODE: state.storage,
            MARTEN_MCP_SQLITE_PATH: state.sqlitePath
          }
        }
      }
    },
    null,
    2
  );
}

export async function ensureBundleExists(bundleFile: string): Promise<void> {
  try {
    await fs.access(bundleFile);
  } catch {
    throw new Error(`Bundle not found at ${bundleFile}. Run 'bun run build:bundle' first.`);
  }
}

export async function copyBundle(bundleFile: string, installDir: string): Promise<string> {
  const target = path.join(installDir, "index.js");
  await fs.mkdir(installDir, { recursive: true });
  await fs.copyFile(bundleFile, target);
  await fs.chmod(target, 0o755);
  return target;
}

export async function writeLauncher(state: InstallState): Promise<void> {
  await fs.mkdir(state.binDir, { recursive: true });
  const launcher = `#!/usr/bin/env sh
set -eu

: "${"MARTEN_MCP_CACHE_DIR:=" + shellEscape(state.cacheDir) + "}"}"
: "${"MARTEN_MCP_STORAGE_MODE:=" + shellEscape(state.storage) + "}"}"
: "${"MARTEN_MCP_SQLITE_PATH:=" + shellEscape(state.sqlitePath) + "}"}"

RUNTIME="${"${MARTEN_MCP_RUNTIME:-" + state.runtime + "}"}"
if [ "$RUNTIME" = "bun" ]; then
  exec bun ${shellEscape(state.bundlePath)} "$@"
fi
if [ "$RUNTIME" = "node" ]; then
  exec node ${shellEscape(state.bundlePath)} "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun ${shellEscape(state.bundlePath)} "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node ${shellEscape(state.bundlePath)} "$@"
fi

echo "Neither node nor bun is available on PATH." >&2
exit 1
`;

  await fs.writeFile(state.launcherPath, launcher, "utf8");
  await fs.chmod(state.launcherPath, 0o755);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
