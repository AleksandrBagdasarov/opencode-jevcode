# Research log — verified on OpenCode 2.2.5 (2026-11-03)

All results come from real runs of `opencode --standalone` with throwaway plugins. Reusable assets live in
`specs/jev-code-router/research/` (not shipped in the package).

| Asset | Purpose |
| --- | --- |
| `research/agent-upsert-probe.ts` | Proves `editor.update(unknownId)` creates an agent. |
| `research/spike-plugin.ts` | Registers a `mock` provider (2 models) + `jevCode` agent; logs hook events; calls `switchModel` in the `prompt` hook. |
| `research/mock-openai-server.mjs` | OpenAI-compatible streaming mock (`/v1/chat/completions`) on `127.0.0.1:18080`; logs the requested model and tool count. Reuse for e2e (ticket 0008). |

## R-1. Agent registration (design F1, F2)

- `AgentEditor` methods: `list, get, default, update, remove`. No `add`.
- `editor.update("jevCode", fn)` creates the agent. It appears in `ctx.agent.list()` and `GET /api/agent` with
  `mode: "primary"`, `hidden: false`, and permissions `[*:*:allow, read *.env ask, read *.env.* ask, read *.env.example allow]`
  until `fn` changes them. Fields set in `fn` (e.g. `description`) are kept.
- A markdown agent file written at runtime and `ctx.agent.reload()` did not duplicate the agent (same single entry).

## R-2. `switchModel` inside the `prompt` hook (ticket 0004 spike) — RESOLVED: works

Run: `opencode --standalone run --agent jevCode --model mock/m-small "say hello"`; the plugin switches to `mock/m-big` in the prompt hook.

- `switchModel` returned in **16 ms**; no deadlock.
- The context hook for the same turn saw `model = mock/m-big`, and the mock provider received `model: "m-big"`
  (both the title request and the agent request). **The switch applies to the same prompt.**
- `ctx.session.get({sessionID})` returns the **SessionInfo directly** (not `{data}`), with `agent` and `model`
  `{id, providerID, variant}` (`variant: "default"`).
- Prompt event keys: `sessionID, messageID, prompt, metadata, delivery` (no agent).

## R-3. Session agent is unset on the first prompt of a default-agent session

Without `--agent`, `session.agent === undefined` in the prompt hook while the context hook reports the real default
(`openagent` for this user). So "unset" cannot be assumed to mean `build`: treat unset as non-jev unless
`makeDefault` (design D8).

## R-4. Real request shape in the `context` hook

- `event.messages[i] = { id: "msg_…", role: "user", content: [{type:"text", text}], metadata: {} }` (message ids are present).
- `event.system` is an array of text parts; one large part (~12 KB) carries `metadata.experimental.instructions`.
- `event.tools` keys (this install): `edit, experimental_image_generate, glob, grep, question, read, shell, skill,
  subagent, todowrite, webfetch, websearch, write, execute` + plugin tools (`specs_*`). `execute` is the Code Mode
  entry that fronts MCP namespaces (e.g. PostgreSQL), so **MCP tools are not individual keys**. Tool groups must
  treat `execute`, `question`, `todowrite`, `skill` as keep-by-default.
- Shell tool id is `shell` (not `bash`); delegation tool is `subagent` (not `task`).

## R-5. Models

`GET /api/model` on this machine: 45 models, all `type: "chat"`, **none `type: "decision"`**. Native Jev
(`opencode/jev-1.13`) is therefore unavailable here; the HTTP transports and the fallback are required.

## R-6. Windows/PowerShell gotcha

`bun`/`opencode` write progress to stderr; PowerShell wraps that as `NativeCommandError`. Check real exit codes with
`cmd /c "cmd >nul 2>&1 & echo exit=%errorlevel%"`.
