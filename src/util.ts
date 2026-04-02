import crypto from "node:crypto";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

export function trigrams(input: string): string[] {
  const normalized = input.toLowerCase();
  if (normalized.length < 3) {
    return normalized ? [normalized] : [];
  }

  const set = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }

  return Array.from(set);
}

export function includesPhraseCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
