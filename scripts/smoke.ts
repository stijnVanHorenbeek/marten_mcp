import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const markdown = args.includes("--markdown");
  const serverMode = readOption(args, "--server") ?? "bun-src";
  const queryArg = args.find((arg) => !arg.startsWith("--") && arg !== serverMode);
  const query = queryArg ?? "session.Query<User>()";
  const format = markdown ? "markdown" : "json";
  const launch = resolveServerLaunch(serverMode);

  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: process.cwd(),
    stderr: "pipe"
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(`[server] ${String(chunk)}`);
    });
  }

  const client = new Client(
    {
      name: "marten-docs-smoke-client",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );

  try {
    await client.connect(transport);

    const status = await client.callTool({
      name: "get_status",
      arguments: { format }
    });

    const search = await client.callTool({
      name: "search_docs",
      arguments: {
        query,
        limit: 3,
        mode: "auto",
        format
      }
    });

    process.stdout.write("get_status:\n");
    process.stdout.write(`${extractText(status)}\n\n`);

    process.stdout.write("search_docs:\n");
    process.stdout.write(`${extractText(search)}\n`);
  } finally {
    await transport.close();
  }
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "(no text content returned)";
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "(no text content returned)";
  }

  const textPart = content.find(
    (item): item is { type: string; text?: string } =>
      typeof item === "object" && item !== null && "type" in item && (item as { type: unknown }).type === "text"
  );
  return textPart?.text ?? "(no text content returned)";
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[smoke] failed: ${message}\n`);
  process.exitCode = 1;
});

function readOption(args: string[], key: string): string | null {
  const idx = args.indexOf(key);
  if (idx < 0) {
    return null;
  }

  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    return null;
  }

  return value;
}

function resolveServerLaunch(mode: string): { command: string; args: string[] } {
  if (mode === "node-dist") {
    return {
      command: "node",
      args: ["dist/index.js"]
    };
  }

  if (mode === "node-bundle") {
    return {
      command: "node",
      args: ["bundle/index.js"]
    };
  }

  if (mode === "bun-bundle") {
    return {
      command: "bun",
      args: ["run", "bundle/index.js"]
    };
  }

  return {
    command: "bun",
    args: ["run", "src/index.ts"]
  };
}
