/**
 * Host-independent plugin setup. index.ts passes the real OpenCode context; tests pass a fake one.
 * Setup NEVER throws: option parsing, logging and every module are guarded.
 */
import { resolveOptions } from "./config.ts";
import { hostEnv } from "./host-env.ts";
import { createLogger, type Logger } from "./log.ts";
import { wireModules, type Cleanup, type Module } from "./modules.ts";

export interface SetupEnv {
  env?: Record<string, string | undefined>;
  /** Log sink override (tests). */
  sink?: (line: string) => void;
}

export async function setupPlugin<Ctx extends { readonly options?: unknown }>(
  ctx: Ctx,
  modules: readonly Module<Ctx>[],
  extra: SetupEnv = {},
): Promise<Cleanup> {
  let log: Logger | undefined;
  try {
    // Callers that pass `extra.env` (tests) are not mixed with the machine config.
    const env = extra.env ?? hostEnv();
    const options = resolveOptions(ctx?.options, env);
    log = createLogger({ debug: options.debug, secrets: [options.apiKey], sink: extra.sink });
    log.debug(`setup: provider=${options.provider} key=${options.apiKeySource}`);
    if (
      !extra.env &&
      options.apiKey &&
      !process.env.TYPESAFE_API_KEY?.trim() &&
      !process.env.OPENROUTER_API_KEY?.trim()
    ) {
      log.info(
        `Jev key was not in the server process environment; using ${options.apiKeySource} from the OpenCode config directory`,
      );
    }
    const wired = await wireModules(modules, ctx, { options, log });
    return wired.cleanup;
  } catch (err) {
    // Defensive: nothing above should throw, but a plugin must never take the host down.
    try {
      (log ?? createLogger({ sink: extra.sink })).error("setup failed; plugin is inactive:", err);
    } catch {
      /* ignore */
    }
    return async () => {};
  }
}
