import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const LOG = "C:/Users/sasha/AppData/Local/Temp/opencode/probe-proj/probe.log"
const log = (m: string) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`)

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    log(`setup dir=${ctx.location.directory} opencode=${ctx.app.version}`)
    const before = await ctx.agent.list()
    log(`agents before: ${JSON.stringify(before.data?.map((a: any) => a.id) ?? before)}`)
    await ctx.agent.transform((editor: any) => {
      log(`editor keys: ${Object.keys(editor).join(",")} typeof add=${typeof editor.add}`)
      try { editor.update("jevCode", (a: any) => { a.description = "from update" }); log("update(unknown) no throw") } catch (e) { log(`update(unknown) threw ${e}`) }
      try { if (typeof editor.add === "function") { editor.add({ id: "jevCode", mode: "primary" }); log("add() called") } } catch (e) { log(`add threw ${e}`) }
    })
    const mid = await ctx.agent.list()
    log(`agents after transform: ${JSON.stringify(mid.data?.map((a: any) => a.id))}`)
    const dir = join(ctx.location.directory, ".opencode", "agents")
    mkdirSync(dir, { recursive: true })
    const f = join(dir, "jevCode.md")
    if (!existsSync(f)) writeFileSync(f, "---\ndescription: probe agent\nmode: primary\n---\n\nYou are the probe agent.\n")
    log("wrote agent md")
    await new Promise((r) => setTimeout(r, 2500))
    await ctx.agent.reload()
    const after = await ctx.agent.list()
    log(`agents after md+reload: ${JSON.stringify(after.data?.map((a: any) => a.id))}`)
    const jev = after.data?.find((a: any) => a.id === "jevCode")
    log(`jevCode entry: ${JSON.stringify(jev)}`)
  },
})
