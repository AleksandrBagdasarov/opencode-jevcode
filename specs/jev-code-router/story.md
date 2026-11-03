# Story — jevCode: a Jev-controlled OpenCode v2 plugin

Source: `feature.md` (architecture brief). Verified against OpenCode **v2.2.5** (`@opencode/plugin@2.2.5`).

## Problem

OpenCode runs every prompt on one model, with every tool and the whole conversation. This wastes money (a strong
model for a one-line edit), time and context (stale history, unused tools), and lowers quality (the wrong skills).

Jev (TypeSafe's System One model) gives fast, calibrated `choice` / `noul` / `score` answers. It does not generate
text or code. We want a plugin where **Jev decides and OpenCode's coding LLM executes**.

## Goal

Ship **one published npm package** (`opencode-jevcode`) that, when installed:

1. Adds a primary agent named **`jevCode`**. It is part of the plugin: no separate file is needed.
2. For each user prompt sent to `jevCode`, Jev chooses the coding model, the skills, the tool groups and the
   relevant context.
3. Applies those decisions to the real OpenCode request (not as advice in a prompt).
4. Leaves every other agent (`build`, `plan`, custom agents) completely untouched.
5. Never makes the coding agent unusable if Jev is slow, down, or not configured.

## Users

- **Developer using OpenCode** — picks `jevCode` with `Tab`; wants cheaper, faster, better-aimed turns.
- **Plugin installer** — runs `opencode plugin add opencode-jevcode`, sets one key (or none), and it works.

## Out of scope

- Using Jev as the coding LLM (Jev cannot generate text or call tools).
- A TUI or GUI part for the plugin.
- Changing OpenCode's permission system (it stays the security boundary).
- Cursor / Claude Code integrations.

## Requirements

Each requirement is verifiable. IDs are used by tickets and tests.

### R1 — Agent ships inside the plugin and is isolated (Phase 1, Essential)

- R1.1 After the plugin loads, `jevCode` is in the agent list with `mode: primary`, a description, and a system
  prompt that tells the model to follow per-request routing and not to assume unavailable tools/skills exist.
- R1.2 `jevCode` has the same permission rules as `build` (copied at registration). The plugin never widens them.
- R1.3 Nothing in the plugin runs for a prompt, model request or compaction whose active agent is not `jevCode`.
  `build`, `plan` and others see no changes to model, skills, tools, messages or system text.
- R1.4 If the in-plugin agent registration does not take effect, the plugin logs a clear error and the package
  provides a ready-to-copy `agents/jevCode.md`. Optionally (`agentFileFallback: true`) the plugin writes it
  to `.opencode/agents/`.
- R1.5 When the user switches from `jevCode` to another agent, the model that was active before Jev routing is
  restored on the next prompt, **unless** the user picked a different model manually in between.

### R2 — Dynamic coding-model selection (Phase 2, Essential)

- R2.1 On each `jevCode` prompt, the plugin builds a restricted candidate list from `ctx.model.list()` (or a
  user allowlist): only enabled, active, tool-capable chat models. Each has provider, id, context window, price
  and a plugin-defined profile (`fast`, `balanced`, `reasoning`, `large-context`).
- R2.2 Jev picks one candidate (a `choice` question). The answer is mapped back to a validated candidate. Any other
  string is rejected. The plugin never switches to an arbitrary provider/model string.
- R2.3 The plugin calls `ctx.session.switchModel()` before the coding request. It skips the call if the chosen
  model is already the session model.
- R2.4 If the choice confidence is below `modelMinConfidence`, or Jev fails, the plugin keeps the current model.
- R2.5 The chosen model's context window is respected (see R5 token budget).

### R3 — Skill selection (Phase 3, High)

- R3.1 Skills come from `ctx.skill.list()`. Jev scores each shortlisted skill with an independent `noul`
  question (several skills may be selected).
- R3.2 Selected skills are added to `event.prompt.skills` as `{ id }` entries. OpenCode resolves and validates
  them. Skill Markdown is never copied into the system prompt by the plugin.
- R3.3 Skills the user already selected are not duplicated. Unknown skill IDs are never added.
- R3.4 At most `maxSkills` skills are added, and only those above `skillThreshold`.

### R4 — Tool availability routing (Phase 4, High)

- R4.1 Tools are grouped into logical groups (Exploration, Development, Execution, Verification, Research,
  Delegation, Database/MCP, Other). Jev decides per group with a `noul` question; code maps groups to tool IDs.
- R4.2 In the `context` hook the plugin deletes tools of excluded groups from `event.tools`. It never deletes:
  a configured always-keep set, tools used in kept messages, and tools whose group is unknown (kept by default).
- R4.3 If filtering would remove all tools, nothing is removed.
- R4.4 Removing a tool from a request is not a permission change. Permission rules are not edited.

### R5 — Context relevance selection (Phase 5, High)

- R5.1 The plugin groups `event.messages` into logical units with stable IDs, token estimates and a short summary.
  It sends Jev a compact `ConversationState`, never the full transcript.
- R5.2 Jev scores / selects relevant units. **Code** applies the selection to `event.messages`. Jev does not
  write summaries.
- R5.3 Always preserved: system messages, the latest user message and everything after it, the last
  `keepRecentMessages` messages, compaction summaries, and every tool-call with its tool-result as one unit.
  Output never contains an orphan tool-call or tool-result.
- R5.4 Pruning only changes the outgoing request. Persisted history is unchanged.
- R5.5 Pruning is skipped when the conversation is small (below `pruneMinTokens`).

### R6 — Turn plan and cost control (Phase 2–5 cross-cutting)

- R6.1 One Jev request per user prompt where practical: model + skills + tool groups are batched (stage A,
  prompt hook). Context relevance is one more request on the first model call of a turn (stage B), skipped for
  small conversations.
- R6.2 The plan is cached per session and turn. Tool-driven continuations reuse it and make **no** Jev call.
- R6.3 A new user message produces a new plan.
- R6.4 A short routing note is added to `event.system` listing the selected skills and available tool groups.

### R7 — Resilience (cross-cutting)

- R7.1 Jev errors, timeouts (`timeoutMs`), invalid answers or a missing key never throw out of a hook. The turn
  runs with a deterministic fallback plan: keep model, no extra skills, all tools, no pruning.
- R7.2 Provider is chosen by `provider: auto | opencode | typesafe | openrouter | none`. `auto` prefers an
  OpenCode-native decision model (`type: "decision"`), then `TYPESAFE_API_KEY`, then `OPENROUTER_API_KEY`,
  otherwise runs in fallback mode and logs a one-time notice.
- R7.3 Secrets are never logged.

### R8 — Jev-assisted compaction (Phase 6, Later)

- R8.1 In the `compaction` hook (only for `jevCode`) Jev selects which information must survive; OpenCode's
  normal compaction model still writes the summary.

### R9 — Routing analytics and evaluation (Phase 7, Later)

- R9.1 Each routing decision (inputs hash, choices, confidences, latency, fallback reason) is stored in plugin
  storage as a bounded log and can be exported for offline evaluation.

### R10 — Distribution

- R10.1 The package installs with `opencode plugin add opencode-jevcode` and loads from the `plugins` array
  with options.
- R10.2 The package ships TypeScript source via `exports`, declares `@opencode/plugin` as a peer dependency, and
  has README, LICENSE, option reference and a troubleshooting section.
- R10.3 `npm pack` contents are verified (no tests, specs or secrets in the tarball); the packed tarball is
  tested by installing it into a clean OpenCode project.

## Acceptance (feature level)

- Selecting `jevCode` and sending a prompt changes the session model according to Jev's choice, and the model
  request reflects the selected skills, tools, and pruned messages.
- Selecting `build` afterwards produces byte-identical requests to a run without the plugin, and the previous
  model is restored.
- Turning the network off (or removing the key) leaves `jevCode` working like a plain agent.

## Priorities

| Phase | Requirement | Priority |
| --- | --- | --- |
| 1 | R1 | Essential |
| 2 | R2 | Essential |
| 3 | R3 | High |
| 4 | R4 | High |
| 5 | R5 | High |
| 6 | R8 | Later |
| 7 | R9 | Later |
| — | R6, R7, R10 | Required with the phases above |
