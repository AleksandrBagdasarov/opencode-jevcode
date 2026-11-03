import type { Module } from "../modules.ts";
import { registerAgent, type AgentCtx } from "./register.ts";

/** Wiring entry for MODULES: registers jevCode and runs the canary. Returns the transform Disposable. */
export const agentModule: Module<AgentCtx> = {
  name: "agent",
  init: (ctx, { options, log }) => registerAgent(ctx, { options, log }),
};
