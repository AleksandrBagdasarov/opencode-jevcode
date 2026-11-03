/**
 * Closed-set validation helpers for Jev answers (design D5: code applies, Jev decides).
 * Every helper is total: it returns null instead of throwing for any input.
 */

import type { Answer, Answers } from "./types.ts";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The chosen value if it is in `allowed` and confidence >= minConfidence; else null. */
export function pickChoice(answer: Answer | undefined, allowed: readonly string[], minConfidence: number): string | null {
  if (!answer || answer.kind !== "choice") return null;
  if (typeof answer.choice !== "string" || !allowed.includes(answer.choice)) return null;
  if (typeof answer.confidence !== "number" || !(answer.confidence >= minConfidence)) return null;
  return answer.choice;
}

/** A noul probability clamped to 0..1; null for any other kind, undefined or NaN. */
export function noulProbability(answer: Answer | undefined): number | null {
  if (!answer || answer.kind !== "noul") return null;
  if (typeof answer.probability !== "number" || Number.isNaN(answer.probability)) return null;
  return clamp(answer.probability, 0, 1);
}

/**
 * Names of noul answers whose key starts with `prefix` and whose (clamped) probability is >= `threshold`,
 * prefix stripped, sorted by probability descending (ties keep answer order).
 */
export function rankNoul(answers: Answers | null | undefined, prefix: string, threshold: number): string[] {
  if (!answers) return [];
  const hits: Array<{ name: string; p: number }> = [];
  for (const [key, ans] of Object.entries(answers)) {
    if (!key.startsWith(prefix)) continue;
    const p = noulProbability(ans);
    if (p !== null && p >= threshold) hits.push({ name: key.slice(prefix.length), p });
  }
  return hits.sort((a, b) => b.p - a.p).map((h) => h.name);
}

/** A score clamped to 0..max; null for other kinds, undefined, NaN or invalid max. */
export function scoreValue(answer: Answer | undefined, max: number): number | null {
  if (!answer || answer.kind !== "score") return null;
  if (typeof answer.score !== "number" || Number.isNaN(answer.score)) return null;
  if (typeof max !== "number" || Number.isNaN(max) || max < 0) return null;
  return clamp(answer.score, 0, max);
}
