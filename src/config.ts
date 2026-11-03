/**
 * Options parsing for the jevCode plugin (design.md section 4).
 * `resolveOptions` never throws: wrong types fall back to defaults, numbers are clamped.
 */

export type ProviderChoice = "auto" | "opencode" | "typesafe" | "openrouter" | "none";
export type ModelProfile = "fast" | "balanced" | "reasoning" | "large-context";

export interface AllowedModel {
  /** `provider/id` */
  model: string;
  profile?: ModelProfile;
}

export interface Resolved {
  provider: ProviderChoice;
  /** Explicit option, else TYPESAFE_API_KEY / OPENROUTER_API_KEY. Never log. */
  apiKey?: string;
  /** Which env var supplied the key (when not given as option); informs provider=auto. */
  apiKeySource: "option" | "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY" | "none";
  endpoint?: string;
  jevModel?: string;
  timeoutMs: number;
  models: AllowedModel[];
  fallbackModel?: string;
  modelMinConfidence: number;
  maxSkills: number;
  skillThreshold: number;
  toolThreshold: number;
  alwaysKeepTools: string[];
  keepRecentMessages: number;
  pruneMinTokens: number;
  contextMinConfidence: number;
  keepFirstUser: boolean;
  makeDefault: boolean;
  agentFileFallback: boolean;
  agentModel?: string;
  debug: boolean;
}

export const DEFAULTS = {
  provider: "auto",
  timeoutMs: 4000,
  modelMinConfidence: 0.5,
  maxSkills: 3,
  skillThreshold: 0.6,
  toolThreshold: 0.4,
  keepRecentMessages: 6,
  pruneMinTokens: 12000,
  contextMinConfidence: 0.5,
  keepFirstUser: true,
  makeDefault: false,
  agentFileFallback: false,
  debug: false,
} as const;

const PROVIDERS: readonly ProviderChoice[] = ["auto", "opencode", "typesafe", "openrouter", "none"];
const PROFILES: readonly ModelProfile[] = ["fast", "balanced", "reasoning", "large-context"];

type Env = Record<string, string | undefined>;

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}

function num(v: unknown, def: number, min: number, max: number, integer: boolean): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  const n = integer ? Math.floor(v) : v;
  return Math.min(max, Math.max(min, n));
}

/** A strictly positive integer; anything else is the default. */
function positiveInt(v: unknown, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  const n = Math.floor(v);
  return n > 0 ? n : def;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** `provider/id` with both parts non-empty. */
export function isModelKey(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const i = v.indexOf("/");
  return i > 0 && i < v.length - 1 && v === v.trim();
}

function modelKey(v: unknown): string | undefined {
  const s = str(v);
  return s && isModelKey(s) ? s : undefined;
}

function models(v: unknown): AllowedModel[] {
  if (!Array.isArray(v)) return [];
  const out: AllowedModel[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    // Accept the bare "provider/id" shorthand as well as { model, profile? }.
    const raw = typeof item === "string" ? item : item && typeof item === "object" ? (item as { model?: unknown }).model : undefined;
    const key = modelKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const p = typeof item === "object" && item ? (item as { profile?: unknown }).profile : undefined;
    const profile = PROFILES.find((x) => x === p);
    out.push(profile ? { model: key, profile } : { model: key });
  }
  return out;
}

/** Never throws: any unexpected failure (e.g. a throwing getter) yields the defaults. */
export function resolveOptions(raw: unknown, env: Env = process.env): Resolved {
  try {
    return resolve(raw, env);
  } catch {
    return resolve(undefined, {});
  }
}

function resolve(raw: unknown, env: Env): Resolved {
  const o: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const provider = PROVIDERS.find((p) => p === o.provider) ?? DEFAULTS.provider;

  let apiKey = str(o.apiKey);
  let apiKeySource: Resolved["apiKeySource"] = apiKey ? "option" : "none";
  if (!apiKey) {
    const ts = str(env.TYPESAFE_API_KEY);
    const or = str(env.OPENROUTER_API_KEY);
    // typesafe wins when both are set, unless the user forced openrouter.
    if (provider === "openrouter") {
      if (or) [apiKey, apiKeySource] = [or, "OPENROUTER_API_KEY"];
    } else if (provider === "typesafe") {
      if (ts) [apiKey, apiKeySource] = [ts, "TYPESAFE_API_KEY"];
    } else if (ts) {
      [apiKey, apiKeySource] = [ts, "TYPESAFE_API_KEY"];
    } else if (or) {
      [apiKey, apiKeySource] = [or, "OPENROUTER_API_KEY"];
    }
  }

  return {
    provider,
    apiKey,
    apiKeySource,
    endpoint: str(o.endpoint),
    jevModel: str(o.jevModel),
    timeoutMs: positiveInt(o.timeoutMs, DEFAULTS.timeoutMs),
    models: models(o.models),
    fallbackModel: modelKey(o.fallbackModel),
    modelMinConfidence: num(o.modelMinConfidence, DEFAULTS.modelMinConfidence, 0, 1, false),
    maxSkills: num(o.maxSkills, DEFAULTS.maxSkills, 0, 50, true),
    skillThreshold: num(o.skillThreshold, DEFAULTS.skillThreshold, 0, 1, false),
    toolThreshold: num(o.toolThreshold, DEFAULTS.toolThreshold, 0, 1, false),
    alwaysKeepTools: strList(o.alwaysKeepTools),
    keepRecentMessages: num(o.keepRecentMessages, DEFAULTS.keepRecentMessages, 0, 10_000, true),
    pruneMinTokens: num(o.pruneMinTokens, DEFAULTS.pruneMinTokens, 0, Number.MAX_SAFE_INTEGER, true),
    contextMinConfidence: num(o.contextMinConfidence, DEFAULTS.contextMinConfidence, 0, 1, false),
    keepFirstUser: bool(o.keepFirstUser, DEFAULTS.keepFirstUser),
    makeDefault: bool(o.makeDefault, DEFAULTS.makeDefault),
    agentFileFallback: bool(o.agentFileFallback, DEFAULTS.agentFileFallback),
    agentModel: modelKey(o.agentModel),
    debug: bool(o.debug, DEFAULTS.debug),
  };
}
