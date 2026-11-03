import { Plugin } from "@opencode/plugin";
import { agentModule } from "./agent/module.ts";
import type { Module } from "./modules.ts";
import { contextHookModule } from "./opencode/context-hook.ts";
import { jevCommandModule } from "./opencode/jev-command.ts";
import { promptHookModule } from "./opencode/prompt-hook.ts";
import { setupPlugin } from "./setup.ts";

type HostContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/**
 * Modules wired at setup. Later tickets append here (compaction hook). Each init is isolated, so one failing
 * never breaks the rest.
 */
export const MODULES: Module<HostContext>[] = [agentModule, promptHookModule, contextHookModule, jevCommandModule];

export default Plugin.define({
  id: "jevcode",
  async setup(ctx) {
    return setupPlugin(ctx, MODULES);
  },
});
