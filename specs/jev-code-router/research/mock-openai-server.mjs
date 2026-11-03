import http from "node:http"
import { appendFileSync } from "node:fs"
const LOG = "C:/Users/sasha/AppData/Local/Temp/opencode/spike/mock.log"
const srv = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let j = {}
    try { j = JSON.parse(body) } catch {}
    const tools = Array.isArray(j.tools) ? j.tools.map((t) => t.function?.name ?? t.name) : []
    appendFileSync(LOG, JSON.stringify({ url: req.url, model: j.model, stream: j.stream, msgs: j.messages?.length, tools: tools.length }) + "\n")
    if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m-small" }, { id: "m-big" }] })); return }
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(chunk({ role: "assistant", content: `answered by ${j.model}` }, null))
      res.write(chunk({}, "stop"))
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`)
      res.end("data: [DONE]\n\n")
    } else {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: j.model, choices: [{ index: 0, message: { role: "assistant", content: `answered by ${j.model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
    }
  })
})
srv.listen(18080, "127.0.0.1", () => console.log("mock listening"))
