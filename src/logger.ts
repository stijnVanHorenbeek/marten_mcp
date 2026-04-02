export function logInfo(message: string, details?: unknown): void {
  if (details === undefined) {
    process.stderr.write(`[INFO] ${message}\n`);
    return;
  }

  process.stderr.write(`[INFO] ${message} ${safeSerialize(details)}\n`);
}

export function logWarn(message: string, details?: unknown): void {
  if (details === undefined) {
    process.stderr.write(`[WARN] ${message}\n`);
    return;
  }

  process.stderr.write(`[WARN] ${message} ${safeSerialize(details)}\n`);
}

export function logError(message: string, details?: unknown): void {
  if (details === undefined) {
    process.stderr.write(`[ERROR] ${message}\n`);
    return;
  }

  process.stderr.write(`[ERROR] ${message} ${safeSerialize(details)}\n`);
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
