/**
 * Tiny module registry. Later tickets add modules (agent, hooks, ...) to the list in index.ts.
 * Each init is isolated: a throwing (or rejecting) module is logged and skipped, never fatal (D6).
 */
import type { Resolved } from "./config.ts";
import type { Logger } from "./log.ts";

/** Anything with `dispose()` - matches the host's hook `Registration`. */
export interface Disposable {
  dispose(): Promise<void> | void;
}

export type Cleanup = () => Promise<void> | void;

export interface Deps {
  options: Resolved;
  log: Logger;
  /** Register something to dispose when the plugin is torn down. Returns it unchanged. */
  track<T extends Disposable | Cleanup>(item: T): T;
}

export interface Module<Ctx> {
  name: string;
  /** May return a Disposable / cleanup function, or call `deps.track`. */
  init(ctx: Ctx, deps: Deps): Promise<Disposable | Cleanup | void> | Disposable | Cleanup | void;
}

export interface Wired {
  /** Names of modules that initialised without error. */
  ok: string[];
  /** Names of modules that failed (already logged). */
  failed: string[];
  /** Disposes everything tracked, in reverse order. Never throws. */
  cleanup: () => Promise<void>;
}

export async function wireModules<Ctx>(
  modules: readonly Module<Ctx>[],
  ctx: Ctx,
  base: { options: Resolved; log: Logger },
): Promise<Wired> {
  const tracked: Array<Disposable | Cleanup> = [];
  const deps: Deps = {
    ...base,
    track: (item) => {
      tracked.push(item);
      return item;
    },
  };
  const ok: string[] = [];
  const failed: string[] = [];

  for (const mod of modules) {
    try {
      const out = await mod.init(ctx, deps);
      if (out) tracked.push(out);
      ok.push(mod.name);
      base.log.debug(`module ${mod.name} ready`);
    } catch (err) {
      failed.push(mod.name);
      base.log.error(`module ${mod.name} failed to initialise; continuing without it:`, err);
    }
  }

  const cleanup = async () => {
    // Dispose once, newest first.
    const items = tracked.splice(0).reverse();
    for (const item of items) {
      try {
        if (typeof item === "function") await item();
        else await item.dispose();
      } catch (err) {
        base.log.warn("cleanup failed:", err);
      }
    }
  };

  return { ok, failed, cleanup };
}
