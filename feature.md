# JevCode — OpenCode v2 plugin architecture

I would build this as a frontier decision router, rather than a conventional Jev integration or a plugin that simply recommends skills.

Your intended workflow:

1. You select `jevCode` as the active agent.
2. You send a request.
3. Jev analyzes the request and the relevant conversation state.
4. Jev decides which coding model, context, tools and skills are appropriate.
5. OpenCode sends the prepared request to the selected coding model.
6. The coding model executes the task using the tools Jev selected.
7. On subsequent user messages, Jev makes a new routing decision.

Switching to `build`, `plan`, or another agent bypasses Jev entirely.

Active agent

jevCode

User submits a prompt

Jev — Frontier Router

Model selection

Context selection

Tool selection

Skill selection

OpenCode request preparation

Selected model + relevant messages + tools + instructions

Selected coding LLM

Implementation, tool calls and verification

Next user message → Jev decides again

## 1. The most important OpenCode v2 APIs

The v2 API gives us almost exactly the interception points needed, but there is an important distinction between model routing and context preparation.

| API                              | Responsibility                                                         |
| -------------------------------- | ---------------------------------------------------------------------- |
| `ctx.session.hook("prompt")`     | Intercept every incoming user prompt                                   |
| `ctx.session.hook("context")`    | Prepare messages, tools and system instructions before model execution |
| `ctx.session.hook("compaction")` | Control conversation compaction                                        |
| `ctx.session.switchModel()`      | Change the session's model                                             |
| `ctx.skill.list()`               | Discover available skills                                              |
| `ctx.agent.transform()`          | Modify agent definitions                                               |

The `context` hook runs before the agent model request, including tool-driven continuations. Its changes affect the outgoing request, not the persistent conversation history.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+3



Important model-routing detail: `event.model` is read-only. I would use the prompt hook to ask Jev for a model decision and then call `ctx.session.switchModel()` before the coding request is made. The context hook should prepare the selected model's input, not attempt to mutate `event.model`.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+1



## 2. How to implement agent isolation

There is one important limitation in the v2 API.

`ctx.agent.transform()` currently supports listing, updating, removing and selecting agents, but its documented `AgentEditor` does not expose an `add()` method.

Therefore, I recommend shipping two components:

- A plugin that handles Jev routing.
- A companion agent definition at `.opencode/agents/jevCode.md`.

For example:

```
---
description: Jev-powered coding agent with dynamic model and context routing
mode: primary
model: your-provider/your-fallback-model
---

You are jevCode, a coding agent controlled by a frontier decision router.

Follow the model, context, skills and tool configuration provided
for each request.

Do not assume that tools or skills unavailable in the current
request are available.
```

You can then switch between `jevCode` and `build` using OpenCode's normal agent switching (`Tab`). Custom Markdown agents support primary mode and model configuration.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+2



How to guarantee isolation:

In the prompt hook, retrieve the session's currently selected agent and return immediately unless its ID is `jevCode`.

In the context hook, the check is even simpler:

```
if (event.agent !== "jevCode") return;
```

The context event exposes the active agent directly.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+1



One subtlety: OpenCode stores the session's selected model separately from its selected agent. Switching to `build` does not automatically restore the model previously configured for `build`.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode



I would handle this by remembering the model selected before entering Jev routing and restoring it on the next prompt submitted to a non-Jev agent, provided the user hasn't manually selected another model.

## 3. The actual plugin lifecycle

I would split the router into two main stages.

Stage A — `prompt` hook

Once per user prompt

1. Identify the active agent.
2. Retrieve previous session context.
3. Prepare the available model and skill catalogs.
4. Ask Jev to select the coding model.
5. Ask Jev which skills should be loaded.
6. Apply the model using `ctx.session.switchModel()`.
7. Add the selected skill IDs to the prompt's selected skills.

Stage B — `context` hook

Before each model request

1. Check that the active agent is `jevCode`.
2. Inspect the assembled conversation messages.
3. Ask Jev which context groups are relevant.
4. Remove irrelevant messages from the outgoing request.
5. Filter unnecessary tools from `event.tools`.
6. Add selected routing instructions to `event.system`.
7. Cache the decision for subsequent tool-call continuations.

Why two stages?

The prompt hook runs once during prompt admission. The context hook runs before the agent's model requests, including continuations after tool execution. They serve different purposes.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+1



Also, the prompt hook runs before skill resolution. You can add selected skills to the prompt and let OpenCode resolve and validate them through its normal mechanism. This is considerably better than manually copying skill Markdown into a system prompt.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+1



An important optimization: don't call Jev on every tool continuation. Make a routing plan once for the current turn and cache it by session ID and turn/message ID. Apply that plan to subsequent context requests until the turn finishes.

## 4. What Jev should decide

I would define one structured decision object inside the plugin:

```
interface TurnPlan {
  model: {
    providerID: string;
    id: string;
  };

  skills: string[];

  tools: {
    groups: string[];
    excluded: string[];
  };

  context: {
    keepMessageIds: string[];
    maxTokens: number;
  };

  confidence: {
    model: number;
    context: number;
  };
}
```

This is your application's internal representation, not a response format that Jev generates directly.

Jev supports three decision primitives:

| Primitive | Application                                      |
| --------- | ------------------------------------------------ |
| Choice    | Select coding model                              |
| Noul      | Decide whether a tool group or skill is relevant |
| Score     | Evaluate context relevance against a rubric      |

You can ask several independent questions about the same state in one API request.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.typesafe.ai\&sz=32)

TypeSafe+2



### Model selection

Use `ctx.model.list()` to obtain available models.

Construct a restricted candidate list containing:

- Model ID and provider.
- Model capabilities, particularly tool support.
- Context window.
- Input/output pricing where available.
- Your own quality and latency classifications.

Ask Jev to choose one of those models.

Example candidate profiles:

| Model profile | Best suited for                    |
| ------------- | ---------------------------------- |
| Fast          | Small edits, simple questions      |
| Balanced      | Normal feature development         |
| Reasoning     | Complex debugging and architecture |
| Large-context | Large codebase analysis            |

These are plugin-defined profiles, not necessarily model categories supplied by OpenCode.

Always map Jev's answer back to a validated model ID. Never accept arbitrary provider/model strings.

### Skill selection

Build a skill catalog using:

```
const skills = await ctx.skill.list();
```

Include skill ID, description and a short description of its actual capabilities.

My suggestion is to use Noul questions for the skills shortlist rather than forcing Jev to select only one skill.

For example, a task involving PostgreSQL aggregation might need both:

- PostgreSQL query optimization.
- Python backend architecture.

Then add the selected skill IDs to `event.prompt.skills`.

### Tool selection

Avoid presenting Jev with a huge list of individual MCP tools.

Instead, create logical tool groups:

| Group        | Examples                      |
| ------------ | ----------------------------- |
| Exploration  | Read, grep, glob, list        |
| Development  | Edit, write, patch            |
| Execution    | Shell, terminal               |
| Verification | Pytest, LSP                   |
| Research     | Web search, web fetch         |
| Delegation   | Subagents, task               |
| Database     | PostgreSQL-specific MCP tools |

Jev decides which capabilities are relevant. Your TypeScript code maps these groups to actual OpenCode tool IDs.

Keep OpenCode's permission system as the actual security boundary. Removing tools from a model request should not replace `allow`, `ask`, and `deny` permission rules.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opencode.ai\&sz=32)

OpenCode+1



## 5. Context management — the most interesting component

This is where I would invest the most engineering effort.

I would not send the entire conversation to Jev. Instead, build a compact representation of the conversation.

For example:

```
interface ConversationState {
  objective: string;

  currentRequest: string;

  activeFiles: string[];

  completedWork: string[];

  unresolvedIssues: string[];

  decisions: Array<{
    id: string;
    summary: string;
  }>;

  contextCandidates: Array<{
    id: string;
    type: "user" | "assistant" | "tool" | "decision";
    summary: string;
    tokenEstimate: number;
  }>;
}
```

The process:

1. Extract conversation history.
2. Group related messages into logical units.
3. Give each unit a stable identifier and a short description.
4. Ask Jev which units are relevant to the current objective.
5. Apply the selection to `event.messages`.
6. Preserve the latest messages and important tool-call/result pairs regardless of Jev's ranking.

For example:

Conversation context candidates

Current task and requirements

Keep

Previous PostgreSQL index investigation

Keep

Unrelated discussions about Git

Remove

Old terminal output

Remove

Recent failed integration test

Keep

Result

# 3 / 5

Illustrative context selection, not an actual Jev response.

One important distinction: Jev doesn't generate summaries.

It can select and score context candidates, but your plugin must implement the actual filtering. OpenCode's normal compaction model can still generate summaries.

I would use two complementary mechanisms:

- `context` hook: temporary, per-request context filtering.
- `compaction` hook: Jev-assisted selection of useful information before OpenCode generates its persistent conversation summary.

This preserves the original conversation while allowing each outgoing model request to have a different context. OpenCode already supports automatic compaction, which replaces older conversation with a summary while retaining recent messages.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://dev.opencode.ai\&sz=32)

OpenCode+2



## 6. Suggested project structure

I would keep the Jev integration independent from OpenCode-specific code.

```
jev-code-router/
│
├── agents/
│   └── jevCode.md
│
├── src/
│   ├── index.ts
│   │
│   ├── jev/
│   │   ├── client.ts
│   │   ├── questions.ts
│   │   └── response.ts
│   │
│   ├── router/
│   │   ├── model-router.ts
│   │   ├── skill-router.ts
│   │   ├── tool-router.ts
│   │   └── context-router.ts
│   │
│   ├── context/
│   │   ├── collector.ts
│   │   ├── distiller.ts
│   │   ├── message-groups.ts
│   │   └── token-budget.ts
│   │
│   ├── opencode/
│   │   ├── prompt-hook.ts
│   │   ├── context-hook.ts
│   │   └── compaction-hook.ts
│   │
│   └── state/
│       └── session-state.ts
│
└── tests/
    ├── model-router.test.ts
    ├── context-router.test.ts
    ├── tool-router.test.ts
    └── agent-isolation.test.ts
```

## 7. Existing implementation worth studying

I found an actual OpenCode v2 community implementation:

[drmaas/jev-router — GitHub](https://github.com/drmaas/jev-router?utm_source=chatgpt.com)

It already demonstrates:

- OpenCode v2 `Plugin.define`.
- Jev HTTP client.
- Skill relevance selection.
- Tool-call steering.
- Permission evaluation.
- Subagent routing.
- Failure analysis.

Its [plugin implementation](https://github.com/drmaas/jev-router/blob/main/plugins/jev-router/index.ts?utm_source=chatgpt.com) is particularly useful.

However, it is not your complete solution. Its current context hook mainly adds skill recommendations to the system instructions. It doesn't implement your desired model selection with `switchModel()` or comprehensive context pruning.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://raw.githubusercontent.com\&sz=32)

GitHub+1



## 8. Implementation roadmap

I would implement this incrementally:

| Phase | Functionality                       | Priority  |
| ----- | ----------------------------------- | --------- |
| 1     | `jevCode` agent and agent isolation | Essential |
| 2     | Dynamic coding model selection      | Essential |
| 3     | Skill selection and injection       | High      |
| 4     | Tool availability routing           | High      |
| 5     | Context relevance selection         | High      |
| 6     | Jev-assisted compaction             | Later     |
| 7     | Routing analytics and evaluation    | Later     |

For the first version, use one Jev request per user prompt wherever practical, combining Choice, Score and Noul questions. Use confidence thresholds and deterministic fallbacks. Jev failures must never make the coding agent unusable.

## My main architectural recommendation

Don't build a plugin where Jev just tells the coding LLM what it should do.

Build a plugin where Jev's decisions are actually applied to OpenCode's request:

- Selected model → `session.switchModel()`.
- Selected skills → prompt skill resolution.
- Selected tools → `event.tools` filtering.
- Selected context → `event.messages` filtering.
- Selected instructions → `event.system` modification.
- Selected persistent context → compaction handling.

This is the difference between a Jev-powered coding agent and a genuinely Jev-controlled orchestration layer.

I would start implementation with Phase 1 and Phase 2: a working `jevCode` agent that automatically selects a coding model on every user prompt, without affecting any other agent.