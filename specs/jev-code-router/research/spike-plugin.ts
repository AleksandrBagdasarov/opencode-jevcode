import { Model, Plugin, Provider } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
const LOG = "C:/Users/sasha/AppData/Local/Temp/opencode/spike/spike.log"
const log = (m: string) => appendFileSync(LOG, `${Date.now()} ${m}\n`)
export default Plugin.define({
  id: "spike",
  async setup(ctx) {
    const providerID = Provider.ID.make("mock")
    const models = ["m-small", "m-big"].map((id) => ({ ...Model.Info.default(providerID, Model.ID.make(id)), name: id }))
    await ctx.provider.transform((editor: any) => {
      editor.add({
        info: { ...Provider.Info.empty(providerID), name: "Mock", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:18080/v1" } },
        models,
      })
    })
    await ctx.agent.transform((editor: any) => {
      editor.update("jevCode", (a: any) => { a.mode = "primary"; a.description = "spike"; a.system = "You are jevCode spike." })
    })
    log(`models: ${JSON.stringify((await ctx.model.list()).data?.filter((m: any) => m.providerID === "mock").map((m: any) => m.id))}`)

    await ctx.session.hook("prompt", async (event: any) => {
      const t0 = Date.now()
      let sess: any
      try { sess = await ctx.session.get({ sessionID: event.sessionID }) } catch (e) { log(`get threw ${e}`) }
      const info = sess?.data ?? sess
      log(`prompt hook: sessionShape=${sess && "data" in sess ? "{data}" : "direct"} agent=${info?.agent} model=${JSON.stringify(info?.model)} keys=${Object.keys(event).join(",")}`)
      if (info?.agent === "jevCode") {
        try {
          const r = await Promise.race([
            ctx.session.switchModel({ sessionID: event.sessionID, model: { providerID: "mock", id: "m-big" } }).then(() => "ok"),
            new Promise((res) => setTimeout(() => res("TIMEOUT-5s"), 5000)),
          ])
          log(`switchModel in prompt hook => ${r} after ${Date.now() - t0}ms`)
        } catch (e) { log(`switchModel threw ${e}`) }
      }
    })
    await ctx.session.hook("context", (event: any) => {
      log(`MESSAGES ${JSON.stringify(event.messages).slice(0,1800)} SYSTEM ${JSON.stringify(event.system.map((s: any) => ({t: s.type, len: s.text?.length, md: Object.keys(s.metadata ?? {})}))).slice(0,400)} TOOLS ${Object.keys(event.tools).join(",")}`); log(`context hook: agent=${event.agent} model=${JSON.stringify(event.model)} msgs=${event.messages.length} tools=${Object.keys(event.tools).length}`)
    })
  },
})

