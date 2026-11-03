/**
 * Keys for the Jev HTTP transports.
 *
 * OpenCode 2.2.5 stores `opencode service set env` in `~/.config/opencode/service.json`
 * but does not put those variables on the server process that loads plugins.
 * A shell child of that process also has no key. Read the managed env (and the
 * config-dir `.env`) only for names that are missing from `process.env`.
 * Never log values from these files.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const JEV_KEY_VARS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;

type Env = Record<string, string | undefined>;

function nonempty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Config directory OpenCode uses on every platform, including Windows. */
export function opencodeConfigDir(env: Env = process.env): string {
  const xdg = nonempty(env.XDG_CONFIG_HOME);
  const base = xdg ?? join(homedir(), ".config");
  return join(base, "opencode");
}

/** Copy `base`, then fill missing Jev key names from `extra`. `base` wins. */
export function mergeMissingKeys(base: Env, extra: Env): Env {
  const out: Env = { ...base };
  for (const name of JEV_KEY_VARS) {
    if (nonempty(out[name])) continue;
    const value = nonempty(extra[name]);
    if (value) out[name] = value;
  }
  return out;
}

/** `service.json` → `env` object. Anything else is `{}`. */
export function parseServiceEnv(text: string): Env {
  try {
    const json = JSON.parse(text) as { env?: unknown };
    const env = json?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return {};
    const out: Env = {};
    for (const name of JEV_KEY_VARS) {
      const value = nonempty((env as Record<string, unknown>)[name]);
      if (value) out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Minimal KEY=VALUE parser. Comments and blank lines are ignored. No expansion. */
export function parseDotEnv(text: string): Env {
  const out: Env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!JEV_KEY_VARS.includes(name as (typeof JEV_KEY_VARS)[number])) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const cleaned = nonempty(value);
    if (cleaned) out[name] = cleaned;
  }
  return out;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Environment `resolveOptions` should see.
 * Precedence: `env` (usually `process.env`), then `service.json`, then `.env`.
 * Never throws.
 */
export function hostEnv(env: Env = process.env, configDir = opencodeConfigDir(env)): Env {
  try {
    let out: Env = { ...env };
    const service = readText(join(configDir, "service.json"));
    if (service) out = mergeMissingKeys(out, parseServiceEnv(service));
    const dotenv = readText(join(configDir, ".env"));
    if (dotenv) out = mergeMissingKeys(out, parseDotEnv(dotenv));
    return out;
  } catch {
    return { ...env };
  }
}
