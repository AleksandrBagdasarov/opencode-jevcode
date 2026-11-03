/**
 * Test-only OpenCode plugin: registers an OpenAI-compatible provider named `mock` with three models
 * (m-small, m-mid, m-big) that talks to the URL in JEVCODE_TEST_MOCK_BASE_URL. The opt-in integration
 * tests copy this file to `<project>/.opencode/plugins/mock-provider/index.ts` (auto-discovered, like the
 * verified spike) because a bare .ts file in the `plugins` array is not loaded by OpenCode 2.2.5.
 */
import { Model, Plugin, Provider } from "@opencode/plugin";

export default Plugin.define({
  id: "jevcode-test-mock-provider",
  async setup(ctx) {
    const baseURL = process.env.JEVCODE_TEST_MOCK_BASE_URL;
    if (!baseURL) return;
    const providerID = Provider.ID.make("mock");
    const models = ["m-small", "m-mid", "m-big"].map((id) => ({
      ...Model.Info.default(providerID, Model.ID.make(id)),
      name: id,
    }));
    await ctx.provider.transform((editor: any) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Mock",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL },
        },
        models,
      });
    });
  },
});
