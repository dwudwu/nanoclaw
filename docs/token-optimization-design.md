# Token Optimization Design

## Use case

A single personal assistant running on NanoClaw, accessed exclusively through one WhatsApp conversation. Two primary use cases, everything in one session:

### 1. Daily news gathering with follow-ups

A scheduled task fires once per day (e.g., 8 AM). The agent searches the web for news on configured topics, reads several pages, and sends a summary to WhatsApp. Later in the day, the user may ask follow-up questions about the news ("tell me more about the OpenAI announcement," "what's the source for that funding round?"). The agent answers from context or re-fetches if needed.

**Token profile:** The scheduled task is the expensive part. Each run produces 50-100k tokens of tool I/O (WebSearch + 3-5 WebFetch calls). The follow-up questions are cheap on their own (~3-5k) but replay the full session history, which includes all prior task runs and their tool output. Without intervention, day 7's follow-up replays ~580k of accumulated history just to answer a simple question.

### 2. Memo CRUD (save/retrieve) — *design to be continued*

The user sends short messages to store and retrieve information: "remember restaurant X, great ramen, near Shibuya station," "what restaurants did I save?," "add milk to my shopping list," "what's on my todo list?" The agent reads/writes files in `/workspace/agent/` to persist this data across sessions.

**Token profile:** Each operation is inherently cheap (~5-7k for a file read or write). But in a shared session, every memo operation pays the full history tax from accumulated news gathers. After 3 days of news tasks, a simple "add milk to my list" costs 200-400k tokens because the transcript includes all prior news fetches.

> **Note:** The optimizations in this document focus on use case 1 (news gathering). A separate design pass for memo CRUD — potentially exploring lighter-weight paths that bypass the full agent turn for simple storage operations — will follow after the news-gather optimizations are implemented and validated.

### Why this matters

Simple one-off questions (weather, unit conversions, "what's the capital of X") do not go through NanoClaw — they go directly to Claude via the app. Only these two use cases justify the NanoClaw infrastructure: scheduled tasks need persistence and cron, memos need durable file storage across sessions.

The single-session constraint is deliberate: the user wants one WhatsApp thread, not separate conversations per use case. This means compaction strategy is critical — without it, the cheap use case (memos) subsidizes the expensive one (news) through shared history.

## Token consumption model

Every message to Claude costs tokens across these buckets:

| Bucket | What | Source | Per-turn cost |
|--------|------|--------|---------------|
| S1 | SDK system prompt | Claude Code's baked-in behavioral rules | ~5-8k |
| S2 | SDK built-in tool schemas | 18 tools in allowlist (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage, TodoWrite, ToolSearch, Skill, NotebookEdit) | ~3-5k |
| S3 | MCP tool schemas | nanoclaw MCP server: ~15 tools (send_message, send_file, edit_message, add_reaction, schedule_task, list_tasks, cancel_task, pause_task, resume_task, update_task, ask_user_question, send_card, create_agent, install_packages, add_mcp_server, whatsapp tools, attachment tools) | ~2-4k |
| S4 | CLAUDE.md instruction fragments | Composed at spawn: shared base (~482 tokens) + core.instructions.md (~587) + scheduling.instructions.md (~512) + interactive.instructions.md (~410) + self-mod.instructions.md (~360) + agents.instructions.md (~558) | ~3k |
| S5 | CLAUDE.local.md agent memory | Per-group persistent memory (restaurants, preferences, people). Grows over time | 0 → 10k+ |
| S6 | Runtime system prompt addendum | Agent identity + destinations map (built in `destinations.ts:buildSystemPromptAddendum`) | ~200-500 |
| S7 | Container skills | 6 skills (agent-browser, frontend-engineer, self-customize, slack-formatting, vercel-cli, welcome). Loaded on-demand via ToolSearch, zero cost unless invoked | ~0 idle |
| H | History (transcript replay) | Full `.jsonl` transcript replayed by SDK every turn: all prior user messages, assistant responses, tool call requests, tool call results | 0 → unbounded |
| T | Current-turn tool I/O | WebFetch pages, WebSearch results, file reads, Bash output, MCP tool results generated this turn | 0-100k+ |
| O | Output tokens | Agent's response text + tool call requests | ~1-5k |

**Fixed floor per turn (S1-S6):** ~14-28k tokens. Cached at 90% discount when prompt prefix is unchanged and cache is warm (5-minute TTL). Always cold for scheduled tasks (24h gap).

**Dominant cost:** H (history) grows without bound. A single news-gather task adds ~75k to the transcript (user prompt + tool calls + tool results + response). After 7 days: ~580k of history on every turn.

---

## Lever H1: Pre-task session clear

### What it is

Before processing a `kind === 'task'` message batch, reset the SDK session (clear the continuation). The agent starts with zero transcript history. Cross-day context (yesterday's news for comparison) comes from files in `/workspace/agent/`, not from the session transcript. Same-day follow-ups still have full history because the clear only fires on the *next* task, not after the current one.

This replaces the earlier post-task compaction design. Compaction paid ~95k tokens per run to produce a ~6k summary the agent didn't actually need — since only yesterday's file matters for comparison, a free session reset is strictly better.

### Where to change

1. **`container/agent-runner/src/poll-loop.ts`** — before `provider.query()`, detect if the batch contains task messages and clear the continuation.
2. **`container/agent-runner/src/config.ts`** — `clearBeforeTask: boolean` in `RunnerConfig`, defaulting to `true`. Opt out with `"clearBeforeTask": false` in container.json.
3. **Agent CLAUDE.md instructions** — must tell the agent to write complete results to dated files (`/workspace/agent/news/YYYY-MM-DD.md`) and read yesterday's file for comparison.

### How it saves

| Day | Without (input) | With clear (input) | With compaction (input) | Clear vs none |
|-----|----------------:|-------------------:|------------------------:|--------------:|
| 1 | 188k | 190k | 214k | -1% (no prior history to clear) |
| 2 | 354k | 195k | 242k | 45% |
| 3 | 520k | 195k | 242k | 63% |
| 7 | 1,184k | 195k | 242k | 84% |
| **7-day total** | **4,802k** | **1,360k** | **1,666k** | **72%** |

Clear beats compaction by ~300k over 7 days, with no extra API calls and no compaction output tokens.

### Tradeoffs

- **Cross-day chat context is lost.** If the user sends "remember this restaurant" at 11 PM and the task fires at 8 AM, the conversation context for that memo is gone. The data is safe in files, but the agent can't reference "what we discussed last night" from transcript memory.
- **Agent must be file-disciplined.** Everything the agent needs to remember across task boundaries must be written to files. CLAUDE.md instructions are critical.
- **Follow-ups still work.** The clear fires *before* the next task, not after the current one. A follow-up 30 minutes after the task sees the full same-day transcript.

### Implementation

```typescript
// In poll-loop.ts, before provider.query():
if (keep.some((m) => m.kind === 'task') && getConfig().clearBeforeTask && continuation) {
  log('Pre-task clear: resetting session for fresh context');
  continuation = undefined;
  clearContinuation(config.providerName);
}
```

---

## Lever H2: Lower compactWindowTokens

### What it is

The Claude Code SDK has a built-in auto-compaction feature controlled by the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable. When the transcript exceeds this token count, the SDK automatically compacts before the next turn. Currently set to 120,000 (120k) in `config.ts:24`.

### Where to change

1. **`container.json` (per-group)** — set `"compactWindowTokens": 50000` (or any lower value).
2. No code changes needed. `config.ts` already reads it, `claude.ts:288` already passes it to the SDK.

### How it saves

Safety net for within-day transcript growth. With H1 (pre-task clear), each day starts fresh, but a long follow-up conversation could still grow the transcript. Lowering the compact window from 120k to 50k means the SDK auto-compacts before the transcript gets too large within a single day.

### Tradeoffs

- **More frequent compaction = more information loss.** At 50k, a complex multi-step follow-up conversation might lose intermediate context.
- **Complementary to H1.** H1 handles the cross-day boundary. H2 handles within-day runaway.

### Recommended value

50k. Allows a single task turn (~75k tool I/O) to complete without mid-turn compaction, but compacts if the user has a long follow-up conversation within the same day.

---

## Lever S1: Capabilities filter for MCP tools

### What it is

The MCP tool barrel (`container/agent-runner/src/mcp-tools/index.ts`) already supports a `capabilities` array in `container.json`. When set, only the listed modules are loaded (plus `core`, which always loads). When `null` (current default), all 6 optional modules load.

Each unloaded module saves its tool schemas from being sent to Claude on every turn.

### Where to change

1. **`container.json` (per-group)** — add `"capabilities": ["scheduling"]`.

No code changes. The mechanism already exists in `mcp-tools/index.ts:30-51`.

### What each module costs

| Module | Tools | Schema tokens | Instruction tokens | Total | Needed for news+memo? |
|--------|-------|--------------|-------------------|-------|----------------------|
| core | send_message, send_file, edit_message, add_reaction | ~800 | ~587 | ~1,400 | **Always loaded** |
| scheduling | schedule_task, list_tasks, cancel_task, pause_task, resume_task, update_task | ~1,000 | ~512 | ~1,500 | **Yes** — scheduled tasks |
| interactive | ask_user_question, send_card | ~600 | ~410 | ~1,000 | **No** — no interactive prompts needed |
| agents | create_agent | ~200 | ~558 | ~750 | **No** — no child agents |
| self-mod | install_packages, add_mcp_server | ~400 | ~360 | ~760 | **No** — stable agent, no self-modification |
| whatsapp | register_group, available_groups | ~500 | 0 | ~500 | **No** — WhatsApp groups already configured |
| attachments | list_attachments, get_attachment_info, cleanup_attachments | ~800 | 0 | ~800 | **Maybe** — only if agent handles file attachments |

### How it saves

Keeping only `scheduling` (plus always-loaded `core`): drops interactive + agents + self-mod + whatsapp + attachments.

Savings: ~(1,000 + 750 + 760 + 500 + 800) = **~3,800 tokens per turn**.

Over 7 days (21 turns): ~80k saved. Not huge on its own, but it's free.

### Tradeoffs

- **Lost capability.** If you later want the agent to install a package or create a child agent, you'd need to update `container.json` and restart the container.
- **No runtime toggle.** The capabilities list is read at MCP server startup. Changing it requires a container restart.

---

## Lever S2: Trim SDK built-in tool allowlist

### What it is

The `TOOL_ALLOWLIST` in `claude.ts:41-61` controls which Claude Code built-in tools the agent can use. Each tool in the list has its JSON schema sent to Claude on every turn. Removing tools the agent never uses saves their schema tokens.

### Where to change

1. **`container/agent-runner/src/providers/claude.ts`** — modify `TOOL_ALLOWLIST`.
2. Ideally: make the allowlist configurable via `container.json` so different agent groups can have different tool sets without code changes.

### Current allowlist and what to trim

| Tool | Schema tokens | Needed for news+memo? | Verdict |
|------|--------------|----------------------|---------|
| Bash | ~300 | Yes — scripts, data processing | Keep |
| Read | ~200 | Yes — reading files | Keep |
| Write | ~200 | Yes — writing memo files | Keep |
| Edit | ~300 | Maybe — minor edits | Keep (useful for memo updates) |
| Glob | ~150 | Maybe — file listing | Keep (light) |
| Grep | ~200 | Maybe — searching files | Keep (useful for memo search) |
| WebSearch | ~200 | Yes — news gathering | Keep |
| WebFetch | ~300 | Yes — reading news pages | Keep |
| Task | ~200 | No — sub-agent tasks | **Remove** |
| TaskOutput | ~150 | No — sub-agent output | **Remove** |
| TaskStop | ~150 | No — sub-agent control | **Remove** |
| TeamCreate | ~200 | No — multi-agent teams | **Remove** |
| TeamDelete | ~150 | No — multi-agent teams | **Remove** |
| SendMessage | ~200 | No — single destination | **Remove** |
| TodoWrite | ~200 | No — internal task lists | **Remove** |
| ToolSearch | ~100 | Yes — deferred skill loading | Keep |
| Skill | ~100 | Yes — container skills | Keep |
| NotebookEdit | ~200 | No — Jupyter notebooks | **Remove** |

### How it saves

Removing Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage, TodoWrite, NotebookEdit: **~1,450 tokens per turn**.

Over 7 days (21 turns): ~30k saved.

### Tradeoffs

- **Reduced flexibility.** If the agent ever needs TodoWrite for internal planning or Task for parallel work, it can't. But for a focused news+memo agent, these are waste.
- **Per-group config would be better.** Hardcoding the allowlist in `claude.ts` affects all agent groups. Making it configurable via `container.json` adds ~20 lines of code but allows different groups to have different tool sets.

---

## Lever S4: Gate instruction fragments on capabilities

### What it is

Currently, `claude-md-compose.ts` loads ALL `*.instructions.md` files from the MCP tools directory regardless of the `capabilities` setting in `container.json`. This means even if `self-mod` tools are not loaded (not in `capabilities`), the `self-mod.instructions.md` (~360 tokens) still appears in the agent's CLAUDE.md.

### Where to change

1. **`src/claude-md-compose.ts`** — when discovering MCP tool instruction fragments, cross-reference with the group's `capabilities` array. Only include fragments whose module name is in `capabilities` (or include all if `capabilities` is `null`).

### How it saves

If `capabilities: ["scheduling"]`, skipped instruction fragments:
- interactive.instructions.md: ~410 tokens
- agents.instructions.md: ~558 tokens
- self-mod.instructions.md: ~360 tokens
- Total: **~1,328 tokens per turn**

Over 7 days (21 turns): ~28k saved.

### Tradeoffs

- **Tight coupling.** The host-side composer now needs to know which instruction files map to which capability names. Currently the mapping is implicit (the file is named `<module>.instructions.md` and the capability key is `<module>`). This convention is fragile — a renamed file breaks the gate.
- **Low risk.** The mapping is simple and already follows a naming convention. A 10-line change in `claude-md-compose.ts`.

---

## Lever T1: Pre-task script for news fetching

### What it is

Scheduled tasks already support a `script` field (see `scheduling.ts:54` and `task-script.ts`). The script runs as a bash process *before* the agent wakes. If the script returns `{ "wakeAgent": true, "data": {...} }`, the data is injected into the task message as `scriptOutput` and the agent sees it in the prompt.

Instead of the agent running 3-5 WebFetch calls (each returning 10-20k of raw HTML text, totaling 50-100k of tool I/O in the transcript), a script can:
1. Fetch news URLs with `curl`
2. Extract text with a lightweight tool (e.g., `readability-cli` or `lynx -dump`)
3. Summarize or truncate to key content
4. Return the result as `scriptOutput` data

The agent then sees a pre-digested ~5-10k summary instead of making tool calls that produce 50-100k of raw content.

### Where to change

1. **No code changes to NanoClaw.** The `script` field and `scriptOutput` injection already work.
2. **Write the script.** A bash script that fetches configured news sources and returns structured JSON.
3. **Install tools in the container.** The script runs inside the container, so any CLI tools it needs (e.g., `readability-cli`) must be in the container image or installed via `install_packages`.
4. **Update the scheduled task.** Call `update_task` to set the `script` field on the existing news-gather task.

### How it saves

| Component | Without script | With script | Saved |
|-----------|---------------:|------------:|------:|
| Tool calls in transcript (T) | 70k (WebSearch + 3-5 WebFetch) | 0 (no tool calls) | 70k |
| Script output in prompt | 0 | 10k (structured summary) | -10k |
| Agent response (O) | 3k | 3k | 0 |
| Added to history (H) | 75k | 15k | 60k |
| **Net per task** | **73k T + 75k H** | **10k T + 15k H** | **~60-65k per task** |

Over 7 days: 7 tasks x ~63k saved = **~440k saved**.

Combined with H1 (compaction), the compaction turn itself is also cheaper because there's less history to summarize.

### Tradeoffs

- **Rigidity.** The script fetches fixed URLs or uses fixed search queries. The agent can't dynamically decide what to search based on context. If the user says "focus on AI news this week," the script doesn't know.
- **Maintenance burden.** News sources change, URLs break, APIs require keys. The script is outside the agent's self-healing capability.
- **Partial solution.** If the user asks a follow-up that requires a fresh web search, the agent still does a full WebFetch. The script only helps the initial scheduled gather.
- **Script timeout.** `task-script.ts` has a 30-second timeout (`SCRIPT_TIMEOUT_MS`). Fetching 5 news sources sequentially might exceed this. Parallel fetching or fewer sources needed.

### Example script

```bash
#!/bin/bash
# Pre-task news fetcher — returns structured JSON for the agent

SOURCES=(
  "https://news.ycombinator.com/rss"
  "https://feeds.bbci.co.uk/news/technology/rss.xml"
)

OUTPUT=""
for url in "${SOURCES[@]}"; do
  content=$(curl -sL --max-time 10 "$url" | head -c 20000)
  OUTPUT="$OUTPUT\n---SOURCE: $url---\n$content"
done

# Return JSON on the last line (task-script.ts reads last line only)
echo "{\"wakeAgent\": true, \"data\": {\"news\": \"$(echo -e "$OUTPUT" | head -c 30000 | sed 's/"/\\"/g' | tr '\n' ' ')\"}}"
```

---

## Lever T2: WebFetch result truncation via hook

### What it is

A `PostToolUse` SDK hook that intercepts WebFetch results and truncates them before they're recorded in the transcript. The file-processor already truncates attachments at 50k characters (`file-processor.ts:243`), but WebFetch results have no such cap.

### Where to change

1. **`container/agent-runner/src/providers/claude.ts`** — modify the existing `postToolUseHook` (or add a new one) to inspect the tool name and truncate the result if it's WebFetch and exceeds a threshold.

### How it saves

A typical news page via WebFetch returns 10-20k tokens. Truncating to 5k per fetch saves ~5-15k per fetch, ~25-75k per task (assuming 5 fetches).

But this is less impactful than T1 (which eliminates the fetches entirely) and more blunt (the truncated content might lose the key information at the bottom of the page).

### Tradeoffs

- **Content loss.** News articles often have the substance after the first few paragraphs. Truncating at 5k characters might cut the actual news and keep the navigation/header boilerplate.
- **SDK hook limitations.** The PostToolUse hook may not expose the tool result for mutation — it may only allow blocking or continuing. Need to verify SDK hook API.
- **Diminishing returns if T1 is implemented.** If the script pre-fetches, there are no WebFetch calls to truncate during the task turn. T2 only helps for follow-up turns where the user triggers new web searches.

### Recommendation

Implement only if T1 is not adopted. If T1 is in place, T2 adds minimal value for the news use case.

---

## Lever S5: Agent memory compaction

### What it is

`CLAUDE.local.md` is the agent's persistent memory, loaded into context on every turn. Over months, as the agent stores restaurants, preferences, people, project notes, etc., this file grows. At 10k+ tokens, it becomes a material per-turn cost.

### Where to change

Not a near-term concern. Current size is 0 (no groups initialized in this checkout). Options when it becomes relevant:

1. **Structured files + index.** Instead of one flat file, the agent stores data in topic files (`restaurants.md`, `people.md`, `todos.md`) and keeps `CLAUDE.local.md` as a lightweight index (~500 tokens). The agent reads specific files on demand via the Read tool.
2. **Periodic summarization.** A background job or hook that summarizes old entries in CLAUDE.local.md, keeping the file under a token budget (e.g., 5k).
3. **CLAUDE.md composition gating.** The host could split CLAUDE.local.md into "always loaded" vs "on demand" sections.

### Recommendation

Defer. The container CLAUDE.md already instructs the agent to create structured files and keep CLAUDE.local.md as a concise index. This is the right architecture — monitor file size over time and intervene if it grows past 5k tokens.

---

## Lever O1: Thinking budget

### What it is

Claude models spend output tokens on extended thinking (chain-of-thought) before producing visible output. For simple tasks (memo save, follow-up question), the thinking is wasted. A thinking budget cap would limit these hidden output tokens.

### Where to change

The Claude Agent SDK v0.2.116 does not expose a `thinkingBudget` parameter in the `query()` options. The SDK manages thinking internally.

### Recommendation

Not actionable today. Monitor for SDK updates that expose this parameter.

---

## Combined impact analysis

### 7-day scenario: 1 daily news task + 1 follow-up

**Baseline (no optimizations):** 4,802k input + 42k output = 4,844k total

| Optimization | Input saved | Output added | Net savings | Cumulative |
|-------------|----------:|------------:|-----------:|-----------:|
| H1 — Pre-task clear | 3,442k | 0 | 3,442k | 3,442k (71%) |
| T1 — Pre-task script | 440k | 0 | 440k | 3,882k (80%) |
| S1 — Capabilities filter | 56k | 0 | 56k | 3,938k (82%) |
| S2 — Trim SDK allowlist | 20k | 0 | 20k | 3,958k (82%) |
| S4 — Gate instruction fragments | 18k | 0 | 18k | 3,976k (83%) |
| H2 — Lower compact window | safety net | 0 | — | — |
| **Total** | **3,976k** | **0** | **3,976k** | **83%** |

**After all optimizations:** ~826k input + 42k output = ~868k total over 7 days.

Pre-task clear saves more than compaction (3,442k vs 3,108k) because it eliminates the compaction turns entirely — no extra API calls, no extra output tokens. The S1/S2/S4 savings are slightly lower (14 turns instead of 21) since there are no compaction turns to pay system overhead on.

### Implementation order

| Phase | Levers | Effort | Savings |
|-------|--------|--------|---------|
| 0 — Config only (no code) | S1 (capabilities), H2 (compact window) | Done (baked defaults) | ~74k / 7 days |
| 1 — Core implementation | H1 (pre-task clear) | Done | ~3,442k / 7 days |
| 2 — Script authoring | T1 (pre-task news script) | Done | ~440k / 7 days |
| 3 — Code refinements | S2 (trim allowlist), S4 (gate fragments) | Done | ~38k / 7 days |

All phases implemented. T1 ships as a shared script at `container/scripts/news-fetch.sh` (+ `news-fetch-worker.ts`), mounted RO at `/app/scripts/` inside the container. Agent schedules with `script: "bash /app/scripts/news-fetch.sh"` and creates `/workspace/agent/news-sources.json` to configure sources.

---

## Open design questions

1. ~~**Script authoring (T1):** Should the news script be per-agent-group (stored in `groups/<folder>/scripts/`) or a shared container skill?~~ **Resolved:** shared script at `container/scripts/`, mounted RO at `/app/scripts/`. Per-group configuration via `/workspace/agent/news-sources.json`.

2. **Memo CRUD optimization:** This document focuses on the news-gather use case. Memo operations are inherently cheap (~5-7k per turn) but still pay the full system floor (~20k). A separate design pass could explore whether memo operations can bypass the SDK entirely (direct file I/O without agent involvement) for simple CRUD patterns.
