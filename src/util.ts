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
  const normalized = input.replace(/[`"'<>()[\]{}.,;:=!?/\\|+]/g, " ");
  const rawTokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const out: string[] = [];
  for (const token of rawTokens) {
    const expanded = expandToken(token);
    out.push(...expanded);
  }

  return out.filter((token) => token.length >= 2);
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

export function paginateTextWindow(
  value: string,
  offset: number,
  maxChars: number,
  minChars = 200,
  maxAllowedChars = 8_000
): {
  value: string;
  offset: number;
  length: number;
  nextOffset: number | null;
  hasMore: boolean;
  totalChars: number;
} {
  const safeOffset = Math.max(0, Math.min(offset, value.length));
  const safeMaxChars = Math.max(minChars, Math.min(maxChars, maxAllowedChars));
  const end = Math.min(value.length, safeOffset + safeMaxChars);
  const slice = value.slice(safeOffset, end);
  const hasMore = end < value.length;

  return {
    value: slice,
    offset: safeOffset,
    length: slice.length,
    nextOffset: hasMore ? end : null,
    hasMore,
    totalChars: value.length
  };
}

function expandToken(token: string): string[] {
  const base = token.toLowerCase();
  const variants = new Set<string>([base]);

  const splitVariants = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);

  for (const part of splitVariants) {
    variants.add(part);
  }

  for (const value of Array.from(variants)) {
    const singular = singularize(value);
    if (singular) {
      variants.add(singular);
    }
  }

  return Array.from(variants);
}

function singularize(token: string): string | null {
  if (token.length <= 3) {
    return null;
  }

  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (/(sses|xes|ches|shes|zes)$/.test(token) && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }

  return null;
}
