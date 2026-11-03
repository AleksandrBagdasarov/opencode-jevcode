/**
 * One Jev client per plugin context, shared by the prompt hook (stage A) and the context hook (stage B): both build
 * it from the same host calls, so the transport resolution and its notices happen once.
 */
import type { Resolved } from "../config.ts";
import { createJevClient, type JevClient } from "../jev/client.ts";
import type { Logger } from "../log.ts";

/** The part of the host `Context` the Jev client needs. */
export interface JevClientCtx {
  readonly model: { list(): Promise<unknown> };
  readonly experimental: { readonly generate: { decisions(input: any, options?: { signal?: AbortSignal }): Promise<unknown> } };
}

const clients = new WeakMap<object, JevClient>();

/** The shared client of `ctx` (created on first use). */
export function jevClientFor(
  ctx: JevClientCtx,
  options: Pick<Resolved, "provider" | "apiKey" | "apiKeySource" | "endpoint" | "jevModel" | "timeoutMs">,
  log: Logger,
): JevClient {
  const existing = clients.get(ctx);
  if (existing) return existing;
  const client = createJevClient({
    options,
    log,
    listModels: () => ctx.model.list(),
    generateDecisions: (input, opts) => ctx.experimental.generate.decisions(input, opts),
  });
  clients.set(ctx, client);
  return client;
}
