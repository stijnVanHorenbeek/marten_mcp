import { logError, logInfo } from "./logger.js";
import { startMcpServer } from "./mcpServer.js";

async function main(): Promise<void> {
  try {
    await startMcpServer();
    logInfo("Marten docs MCP server started over stdio");
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    logError("Fatal startup error", message);
    process.exitCode = 1;
  }
}

void main();
