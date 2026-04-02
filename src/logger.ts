type LogLevel = "info" | "warn" | "error";

let eventCounter = 0;

export function logInfo(message: string, details?: unknown): void {
  writeStructuredLog("info", message, details);
}

export function logWarn(message: string, details?: unknown): void {
  writeStructuredLog("warn", message, details);
}

export function logError(message: string, details?: unknown): void {
  writeStructuredLog("error", message, details);
}

function writeStructuredLog(level: LogLevel, message: string, details?: unknown): void {
  const baseRecord = {
    ts: new Date().toISOString(),
    level,
    eventId: nextEventId(),
    message
  };

  if (details === undefined) {
    process.stderr.write(`${safeSerialize(baseRecord)}\n`);
    return;
  }

  const record = {
    ...baseRecord,
    context: details
  };
  process.stderr.write(`${safeSerialize(record)}\n`);
}

function nextEventId(): string {
  eventCounter += 1;
  const counter = eventCounter.toString(36).padStart(4, "0");
  const ts = Date.now().toString(36);
  return `evt_${ts}_${counter}`;
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
