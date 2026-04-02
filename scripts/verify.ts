import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launcherPathFor, resolveOptions, statePathFor } from "./lifecycle-lib.js";

const REQUEST_TIMEOUT_MS = 180_000;

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  const launcherPath = launcherPathFor(options.binDir);
  const statePath = statePathFor(options.installDir);

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const stateExists = await fileExists(statePath);
  checks.push({
    name: "install_state",
    ok: stateExists,
    detail: stateExists ? `Found ${statePath}` : `Missing ${statePath}`
  });

  const launcherExists = await fileExists(launcherPath);
  checks.push({
    name: "launcher",
    ok: launcherExists,
    detail: launcherExists ? `Found ${launcherPath}` : `Missing ${launcherPath}`
  });

  let getStatusOk = false;
  let searchOk = false;
  let runtimeError: string | null = null;
  if (launcherExists) {
    try {
      const transport = new StdioClientTransport({
        command: launcherPath,
        args: [],
        cwd: process.cwd(),
        env: toStringEnv(process.env),
        stderr: "pipe"
      });
      if (transport.stderr) {
        transport.stderr.on("data", (chunk) => {
          process.stderr.write(`[server] ${String(chunk)}`);
        });
      }

      const client = new Client({ name: "marten-verify", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      await client.callTool({ name: "get_status", arguments: {} }, undefined, { timeout: REQUEST_TIMEOUT_MS });
      getStatusOk = true;
      await client.callTool(
        { name: "search_docs", arguments: { query: "aggregate projections", limit: 2, mode: "auto" } },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS }
      );
      searchOk = true;
      await transport.close();
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }
  }

  checks.push({
    name: "mcp_get_status",
    ok: getStatusOk,
    detail: getStatusOk ? "Tool call succeeded" : runtimeError ?? "Tool call failed"
  });
  checks.push({
    name: "mcp_search_docs",
    ok: searchOk,
    detail: searchOk ? "Tool call succeeded" : runtimeError ?? "Tool call failed"
  });

  const ok = checks.every((check) => check.ok);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`# Verify\n\n`);
    for (const check of checks) {
      process.stdout.write(`- [${check.ok ? "OK" : "FAIL"}] ${check.name}: ${check.detail}\n`);
    }
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[verify] failed: ${message}\n`);
  process.exitCode = 1;
});
