/**
 * Token estimates and budget fitting for message pruning (story R5, design section 5).
 *
 * Estimates are deliberately rough (characters / 4): they only decide how much of the history fits, never what
 * is billed. Every function is total (never throws).
 */

/** One token is about this many characters. */
export const CHARS_PER_TOKEN = 4;
/** Share of the model's context window the kept history may use (leaves room for system prompt, tools and output). */
export const CONTEXT_BUDGET_RATIO = 0.6;

/** Character length of a value: strings as they are, anything else as JSON (unserialisable values count 64). */
export function charLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 64;
  }
}

/** Estimated tokens for `chars` characters (rounded up). */
export function tokensFromChars(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

/** Estimated tokens of any value. */
export function estimateTokens(value: unknown): number {
  return tokensFromChars(charLength(value));
}

/**
 * The token budget of the kept history: `min(planMaxTokens, modelContext * ratio)`. Values that are not positive
 * finite numbers are ignored; with neither the budget is unlimited (`Infinity`).
 */
export function contextBudget(planMaxTokens?: unknown, modelContext?: unknown, ratio: number = CONTEXT_BUDGET_RATIO): number {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const limits: number[] = [];
  if (ok(planMaxTokens)) limits.push(planMaxTokens);
  if (ok(modelContext)) limits.push(Math.floor(modelContext * (Number.isFinite(ratio) && ratio > 0 ? ratio : CONTEXT_BUDGET_RATIO)));
  return limits.length > 0 ? Math.min(...limits) : Number.POSITIVE_INFINITY;
}

export interface FitUnit {
  id: string;
  tokens: number;
  /** Relevance score; higher is more relevant. */
  score: number;
  /** Forced units are always kept, even when that exceeds the budget. */
  forced: boolean;
}

export interface FitResult {
  keep: Set<string>;
  /** Ids that were not kept, in input order. */
  dropped: string[];
  /** Estimated tokens of the keep set. */
  tokens: number;
  /** True when the forced units alone exceed the budget. */
  overBudget: boolean;
}

/**
 * Picks the keep set: forced units always; other units only with `score >= minScore`; then, while over `budget`,
 * the lowest-scored non-forced unit goes first (ties: the oldest, i.e. the earliest in `units`).
 */
export function fitToBudget(units: readonly FitUnit[], opts: { budget: number; minScore: number }): FitResult {
  const budget = typeof opts.budget === "number" && !Number.isNaN(opts.budget) ? Math.max(0, opts.budget) : Number.POSITIVE_INFINITY;
  const tokensOf = (u: FitUnit) => (Number.isFinite(u.tokens) && u.tokens > 0 ? u.tokens : 0);
  const keep = new Set<string>();
  const eligible: Array<{ unit: FitUnit; order: number }> = [];
  let total = 0;
  units.forEach((unit, order) => {
    if (unit.forced) {
      keep.add(unit.id);
      total += tokensOf(unit);
    } else if (unit.score >= opts.minScore) {
      keep.add(unit.id);
      total += tokensOf(unit);
      eligible.push({ unit, order });
    }
  });
  eligible.sort((a, b) => a.unit.score - b.unit.score || a.order - b.order);
  for (const { unit } of eligible) {
    if (total <= budget) break;
    keep.delete(unit.id);
    total -= tokensOf(unit);
  }
  return {
    keep,
    dropped: units.filter((u) => !keep.has(u.id)).map((u) => u.id),
    tokens: total,
    overBudget: total > budget,
  };
}
