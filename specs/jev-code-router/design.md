# Design — jevCode router plugin

Target: OpenCode **v2.2.5**, `@opencode/plugin@2.2.5` (Promise API, `Plugin.define`). Runtime: Bun/Node, TypeScript source
published as-is (`exports` → `./src/index.ts`).

## 1. Verified platform facts (these change feature.md)

Checked against the installed package types and a live probe plugin on OpenCode 2.2.5.

| # | Fact | Consequence |
| --- | --- | --- |
| F1 | `AgentEditor` has `list/get/default/update/remove` — **no `add()`**. | feature.md was right about the API. |
| F2 | **`editor.update("jevCode", fn)` on an unknown id creates the agent** (probe: listed with `mode: primary`, default allow-all permissions, fields from `fn` applied). | The agent **can** live inside the plugin. Behaviour is undocumented → guarded by a canary (D2). |
| F3 | The `prompt` hook event is `{ sessionID, messageID, prompt, metadata, delivery }`. **No `agent`.** | Active agent must come from `ctx.session.get({sessionID}).agent` (optional field). |
| F4 | The `context` hook event is `{ sessionID, agent, model, system, messages, tools, options }`. | Isolation in stage B is a one-line guard. `model` is readonly. |
| F5 | `prompt.skills` items are `{ id, mention? }`, not strings. | Add `{ id: Skill.ID }` objects after validating against `ctx.skill.list()`. |
| F6 | `Message` = `{ id?, role: system\|user\|assistant\|tool, content: Part[] }`; `tool-call` and `tool-result` parts share `id`. | Pair by part `id`. Message `id` is optional → synthesize stable ids. |
| F7 | `event.tools` is `Record<toolId, {description,input}>`; deleting a key removes it from the request. | Filtering = key deletion. |
| F8 | `ctx.model.list()` returns `ModelInfo` with `type` (`chat`\|`decision`\|`image`), `capabilities.tools`, `limit.context`, `cost[]`, `status`, `enabled`. | Candidate catalog + native-Jev discovery. |
| F9 | `ctx.experimental.generate.decisions({model, input, questions})` supports `predicate` / `choice{choices[]}` / `score{levels[]}`. Answers: `probability` / `choice+confidence+probabilities` / `score+confidence`. | Native transport. **No decision model is installed on the dev machine** (45 chat models, 0 decision) → cannot be the only transport. |
| F10 | TypeSafe HTTP: `POST https://api.typesafe.ai/v1/systemone` `{model,state,questions}` with `noul` / `choice{criteria map, ≤255}` / `score{criteria[], ≤10}`; Bearer key. OpenRouter variant: `POST https://openrouter.ai/api/alpha/decisions`. | Two HTTP transports. |
| F11 | Hooks: `ctx.session.hook("prompt"\|"context"\|"compaction", cb)`; hook options (provider scope) are not allowed for `prompt`. | Register each hook once; guard inside. |
| F12 | `ctx.session.switchModel({sessionID, model:{providerID,id}})`; session stores model separately from agent. | Needs restore logic (R1.5). |
| F13 | An `experimental.idle` hook exists in types but not in docs. | Not used in v1. |
| F14 | `ctx.storage` is durable JSON per plugin id. | Model-restore memory + analytics log. |
| F15 | **Plugin entries in the config `plugins` array must be objects `{ package, options }`** (as used by the e2e tests: `package` = package name or repo path with forward slashes). A bare `.ts` path in the array is **not** loaded. | Docs/README show the object form only. |
| F16 | Local plugins are auto-discovered from **`.opencode/plugins/<name>/index.ts`** (directory with `index.ts`). | Test-only helpers (mock provider fixture) are installed this way, not via the `plugins` array. |
| F17 | **A UTF-8 BOM at the start of `package.json` makes opencode 2.2.5 silently skip the plugin** (no log, no error). | `package.json` (and any file edited via PowerShell `Set-Content`/`Out-File`) is written as UTF-8 **without** BOM; the opt-in integration test is the guard. |

## 2. Decisions

- **D1 Distribution.** One npm package `opencode-jevcode`; server part only; TS source in `exports`; `@opencode/plugin`
  peer + pinned dev dependency (OpenCode redirects it to the host copy). No bundler.
- **D2 Agent registration.** `ctx.agent.transform(editor => editor.update("jevCode", …))` (F2). The callback is
  idempotent (transforms replay on reload). It sets `description`, `mode: "primary"`, `system`, `color`, optional
  `model`, and **copies `build`'s `permissions`** (R1.2). After setup a **canary** checks `ctx.agent.list()` for
  `jevCode`. If missing → log error; if `agentFileFallback` → write `.opencode/agents/jevCode.md` from the packaged
  copy. A test pins the upsert behaviour so an OpenCode update that breaks it is noticed.
- **D3 Two-stage routing** (as in feature.md §3). Stage A = `prompt` hook (once per prompt): model + skills + tool
  groups in **one** batched Jev request. Stage B = `context` hook, first call of a turn only: context relevance
  (one request, skipped for small conversations). Continuations read the cached plan.
- **D4 Provider-neutral Jev client.** Internal question model `{kind: choice|noul|score}`; transports map it:
  `opencode-native` (F9, `noul→predicate`), `typesafe` (F10), `openrouter`. All transports: timeout, one retry on
  5xx/network, never throw, return `null` on failure.
- **D5 Code applies, Jev decides.** Every Jev output is validated against a closed set built by code (model keys,
  skill ids, group names, unit ids). Unknown answers are discarded.
- **D6 Fail open.** Every hook body is wrapped; any error → fallback plan (keep model, no skills, all tools, no
  pruning). Hooks never throw, never block on Jev longer than `timeoutMs`.
- **D7 Pruning safety.** Prune on *units*, not messages (§5). Property tests assert no orphan tool parts.
- **D8 Isolation by construction.** One `isJevAgent(agentId)` predicate; every hook returns before touching state
  when false. The prompt hook resolves the agent via `session.get` and treats an unset agent as jev only if
  `makeDefault: true` (the plugin also calls `editor.default("jevCode")` in that case).

## 3. Module layout

```
opencode-jevcode/
├─ package.json  tsconfig.json  README.md  LICENSE
├─ agents/jevCode.md                  packaged fallback copy of the agent
├─ src/
│  ├─ index.ts                        Plugin.define: wiring only
│  ├─ config.ts                       options parsing, defaults, validation
│  ├─ log.ts                          leveled logger, secret redaction
│  ├─ agent/
│  │  ├─ definition.ts                JEV_AGENT_ID, prompt text, build-permission copy
│  │  ├─ register.ts                  transform + canary + file fallback
│  │  └─ isolation.ts                 isJevAgent, resolveSessionAgent
│  ├─ jev/
│  │  ├─ types.ts                     Question / Answer / JevRequest
│  │  ├─ client.ts                    provider selection, timeout, retry, fail-open
│  │  ├─ transports/{native,typesafe,openrouter}.ts
│  │  ├─ questions.ts                 builders for model / skills / tool groups / context
│  │  └─ response.ts                  closed-set validation, confidence helpers
│  ├─ router/
│  │  ├─ plan.ts                      TurnPlan type, fallback plan
│  │  ├─ model-router.ts  skill-router.ts  tool-router.ts  context-router.ts
│  │  └─ tool-groups.ts               group → tool id patterns
│  ├─ context/
│  │  ├─ message-groups.ts            messages → units (tool pairs atomic)
│  │  ├─ distiller.ts                 units → ConversationState
│  │  ├─ token-budget.ts              estimates, budget fitting
│  │  └─ collector.ts                 active files / completed work extraction
│  ├─ opencode/
│  │  ├─ jev-client.ts                 jevClientFor(ctx, options, log): ONE shared Jev client per host ctx (WeakMap)
│  │  ├─ prompt-hook.ts  context-hook.ts  compaction-hook.ts
│  └─ state/session-state.ts          plan cache, routed-model memory (storage-backed)
└─ tests/                             unit + property + integration (mock server)
```

## 4. Data contracts

```ts
interface TurnPlan {
  sessionID: string;
  turnKey: string;                       // latest user message id, else hash(text)+count
  createdAt: number;
  source: "jev" | "fallback";
  fallbackReason?: string;
  model?: { providerID: string; id: string; confidence: number }; // absent = keep
  skills: string[];                      // validated ids
  tools: { groups: string[]; excluded: string[] };
  context?: {
    keepUnitIds: string[];               // kept units (scored + forced)
    droppedUnitIds?: string[];           // units dropped at the first call; continuations re-apply exactly these (0007)
    maxTokens: number;                   // budget used; 0 = no budget known
    confidence: number;                  // mean confidence of the usable answers
  };
}
```

`droppedUnitIds` exists because "messages created during the turn are always kept" cannot be derived from
`keepUnitIds`: a unit that did not exist at the first call is in neither set, and continuations drop **only** ids listed
in `droppedUnitIds` (unknown/new units are kept). The stage also memoises its first-call decision per plan object
(WeakMap + in-flight dedupe, so concurrent first calls share one Jev request) and falls back to `droppedUnitIds` when
the plan object is re-read from the cache without the in-memory decision.

Options (`ctx.options`): `provider`, `apiKey`, `endpoint`, `jevModel`, `timeoutMs` (default 4000), `models`
(allowlist `[{model:"provider/id", profile?}]`), `fallbackModel`, `modelMinConfidence` (0.5), `maxSkills` (3),
`skillThreshold` (0.6), `toolThreshold` (0.4), `alwaysKeepTools`, `toolGroups` (`{ "<group>": ["<id glob>", …] }`, default `{}`; see "Tool groups" below),
`keepRecentMessages` (6), `keepFirstUser` (true), `pruneMinTokens` (12000),
`contextMinConfidence` (0.5), `makeDefault` (false), `agentFileFallback` (false), `agentModel`, `debug` (false).
Secrets may come from env: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`.

### Tool groups (`src/router/tool-groups.ts`, ticket 0006)

Code maps tool ids to groups; Jev only judges the groups (`noul tools:<group>`). Patterns are case-insensitive globs
(`*`, `?`) matched against the **whole** tool id; first matching group wins. A tool matching no pattern is
**ungrouped and never excluded**.

| Built-in group | Patterns |
| --- | --- |
| Exploration | `read`, `grep`, `glob`, `list`, `ls` |
| Development | `edit`, `multiedit`, `write`, `patch`, `apply_patch` |
| Execution | `shell`, `bash`, `powershell`, `terminal` |
| Verification | `test`, `lsp`, `diagnostics` |
| Research | `websearch`, `webfetch`, `codesearch` |
| Delegation | `subagent`, `task` |
| Database (MCP) | `*postgres*`, `*mysql*`, `*mariadb*`, `*sqlite*`, `*mongo*`, `*database*`, `*redis*` |
| Other | none built in (only fed by `toolGroups`); not asked while it has no patterns |

`toolGroups` **adds** patterns to a built-in group (case-insensitive name match, de-duplicated) or creates a new group
for an unknown name; it never removes built-in patterns. Option parsing drops empty names/lists, `__proto__` and
non-object values (→ `{}`); patterns longer than 200 chars are ignored. A group is excluded when its `noul`
probability is `< toolThreshold`; an unanswered/invalid group is kept. Removal (`selectToolRemovals`) never deletes
`alwaysKeepTools` (globs), tools referenced by `tool-call`/`tool-result` parts in the request, or ungrouped tools, and
deletes nothing if it would remove every tool. No permission/access-rule API is used (a test greps for it).

### Constants

| Constant | Value | Where |
| --- | --- | --- |
| Keep-score threshold (`CONTEXT_KEEP_MIN_SCORE`) | **2** (scale 0–4; below 2 → drop candidate) | `router/context-router.ts` |
| Unit split cap (`DEFAULT_UNIT_MAX_TOKENS`) | **6000** tokens (estimate = chars/4) | `context/message-groups.ts` |
| Max score questions per request (`CONTEXT_MAX_QUESTIONS`) | **60** | `router/context-router.ts` |
| Context budget | `min(plan.maxTokens, model window × 0.6)`; ∞ if neither is known | `context/token-budget.ts` |
| Distilled state cap | 9000 chars (< Jev client truncation at 12000, which would break the JSON) | `context/distiller.ts` |

## 5. Flows

### Stage A — `prompt` hook

1. `agent = (await ctx.session.get({sessionID})).agent`. Not jev → run **restore** (R1.5) and return.
2. Load catalogs (model candidates, skills, tool groups) — cached with short TTL.
3. One batched Jev request: `choice(model)` + `noul(skill:<id>)` per shortlisted skill (lexical prefilter ≤ 30) +
   `noul(tools:<group>)` per group.
4. Validate against closed sets (D5) and apply thresholds → `TurnPlan` (partial).
5. `switchModel` if needed; remember `{previous, applied}` in storage. Push `{id}` skills into `event.prompt.skills`.
6. Save plan in `session-state`. On any failure save the fallback plan.

**Open risk (spike in ticket 0004):** calling `switchModel` from inside the `prompt` hook might contend with prompt
admission. If it deadlocks or does not affect the same turn, fall back to switching in a microtask after admission.
The result of the spike is logged as an ADR.

### Stage B — `context` hook

1. `event.agent !== "jevCode"` → return.
2. Find plan for `event.sessionID` and validate `turnKey` against the latest user message (message id, then the
   text-hash spelling); stale/missing → fallback plan.
3. **Stage B is skipped when stage A produced a fallback plan** (`plan.source !== "jev"`, incl. stale/missing plans):
   no pruning and no Jev request; tool filtering and the minimal routing note still follow the fallback plan (all tools
   kept). Otherwise, first model call of the turn and conversation ≥ `pruneMinTokens` → build units, **one** Jev
   request with a `score` question (0–4) per non-forced unit — ≤ 60 questions (`CONTEXT_MAX_QUESTIONS`): the newest 30
   stay one-per-unit, older units are merged into groups — then keep units scoring ≥ 2 (unanswered / low-confidence
   units are kept), dropping lowest scores first (oldest on ties) while over budget. Forced units are never asked
   about and never dropped.
4. Apply: prune `event.messages` (post-condition checked, else original messages), delete excluded tools, append the
   routing note as a **new** system part (never modify existing parts).
5. Cache result on the plan (`context.droppedUnitIds`). Continuations only re-apply (no Jev call).

Both stages obtain Jev through `jevClientFor(ctx, options, log)` (`src/opencode/jev-client.ts`): one client per host
`ctx`, so transport resolution and its one-time notices happen once. `createContextHook` stays stage-agnostic; the
pruning stage is injected as `ContextStage[]` by `contextHookModule`, and a failure creating or running a stage never
disables tool filtering.

### Unit grouping and safety invariants (R5.3)

- Unit = a user message plus the assistant/tool messages that answer it up to the next user message, split further
  only when a unit exceeds the size cap (6000 tokens) at a point where no tool id spans the cut. Inside a unit, each `tool-call` and its matching `tool-result` are indivisible.
- Forced keep: system messages; the last user message and everything after it; last `keepRecentMessages`; any message
  with a compaction part; the first user message when `keepFirstUser` (default true).
- Post-condition check (always executed): every `tool-result.id` has a prior `tool-call.id` and vice versa; otherwise
  the whole prune is discarded and the original messages are used.
- Tools referenced by kept `tool-call` parts are never deleted from `event.tools`.

### Isolation and restore

- `isJevAgent(id) = id === "jevCode"` is the single predicate.
- Restore memory `{sessionID → {previous, applied}}` in `ctx.storage` (survives restarts). On a prompt for a non-jev
  agent: if `session.model` equals `applied` → `switchModel(previous)` and clear; otherwise (user changed it) just clear.

### Jev question shapes (internal)

| Decision | Kind | Closed set |
| --- | --- | --- |
| Model | choice | candidate keys `provider/id` (+ `keep` option) |
| Skill | noul × N | shortlisted skill ids |
| Tool group | noul × G | group names |
| Context unit | score × U | unit ids (scale 0–4) |

## 6. Test strategy

- **Unit:** config, closed-set validation, question builders, transports (mock `fetch`), tool grouping, units,
  token budget, plan cache, restore logic.
- **Property tests:** pruning never produces orphan tool parts; forced-keep set always present; filtering never empties tools.
- **Isolation test:** drive all three hooks with `agent: "build"` and assert zero mutations and zero Jev calls.
- **Fail-open test:** transport throws / times out / returns garbage → fallback plan, no exception.
- **Agent canary:** integration test against the real `opencode` binary (`--standalone api get /api/agent`) asserts `jevCode` exists.
- **Integration (QA):** mock OpenAI-compatible provider + mock Jev server; install packed tarball into a clean project.

## 7. Out of scope / later

Phase 6 compaction (R8) and Phase 7 analytics (R9) are specified in the story and ticketed, but not part of v0.1.
