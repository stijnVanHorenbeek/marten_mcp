import { describe, expect, test } from "bun:test";
import { logInfo } from "../src/logger.js";

describe("structured logger", () => {
  test("emits json log with event id", () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];

    process.stderr.write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      logInfo("test message", { scope: "unit" });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]?.trim() ?? "{}") as {
      level?: string;
      eventId?: string;
      message?: string;
      context?: { scope?: string };
    };
    expect(parsed.level).toBe("info");
    expect(parsed.eventId?.startsWith("evt_")).toBe(true);
    expect(parsed.message).toBe("test message");
    expect(parsed.context?.scope).toBe("unit");
  });
});
