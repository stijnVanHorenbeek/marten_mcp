import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveTelemetryInputPath(explicitInput?: string): string {
  if (explicitInput && explicitInput.trim().length > 0) {
    return path.resolve(explicitInput.trim());
  }

  const envPath = process.env.MARTEN_MCP_TELEMETRY_PATH?.trim();
  if (envPath && envPath.length > 0) {
    return path.resolve(envPath);
  }

  return path.join(os.homedir(), ".cache", "marten-docs-mcp", "telemetry");
}

export async function resolveTelemetryInputFile(options: {
  explicitInput?: string;
  latest: boolean;
}): Promise<{ resolvedInputPath: string; filePath: string }> {
  const resolvedInputPath = resolveTelemetryInputPath(options.explicitInput);
  const stats = await safeStat(resolvedInputPath);
  if (!stats) {
    throw new Error(`Telemetry input not found. Checked: ${resolvedInputPath}`);
  }

  if (stats.isFile()) {
    return { resolvedInputPath, filePath: resolvedInputPath };
  }

  if (!stats.isDirectory()) {
    throw new Error(`Telemetry input is neither file nor directory: ${resolvedInputPath}`);
  }

  if (!options.latest) {
    throw new Error(`Telemetry input is a directory: ${resolvedInputPath}. Pass --latest or provide --input <file>.`);
  }

  const latestFile = await findLatestJsonlFile(resolvedInputPath);
  if (!latestFile) {
    throw new Error(`No telemetry .jsonl files found in: ${resolvedInputPath}`);
  }

  return {
    resolvedInputPath,
    filePath: latestFile
  };
}

async function safeStat(targetPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function findLatestJsonlFile(dirPath: string): Promise<string | null> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (files.length === 0) {
    return null;
  }

  let bestPath = path.join(dirPath, files[0]!.name);
  let bestMtime = (await fs.stat(bestPath)).mtimeMs;

  for (let i = 1; i < files.length; i++) {
    const candidatePath = path.join(dirPath, files[i]!.name);
    const candidateMtime = (await fs.stat(candidatePath)).mtimeMs;
    if (candidateMtime >= bestMtime) {
      bestMtime = candidateMtime;
      bestPath = candidatePath;
    }
  }

  return bestPath;
}
