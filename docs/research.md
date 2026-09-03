# Argo research — planning and memory for local-model agents

Consolidated background research behind Argo's harness design, merged from two
surveys. Sources are cited inline. Part 1 covers getting local models to plan
before implementing; Part 2 covers compaction and context/memory management.

> ## 2026-09-03 — PARTIALLY SUPERSEDED. Read this before acting on anything below.
>
> This document was written on 2026-07-25 / 2026-07-27, **before Argo had any measurements of its own
> mechanisms firing.** Those measurements now exist: 567 run logs, ~5 000 model turns, 32 mechanisms
> graded. The consolidated body that merges this survey with that evidence is
> [`docs/research/`](research/README.md) — one document per concept, each with a *simplest sufficient
> implementation*, known traps, and a validation plan, plus
> [`docs/research/interaction-matrix.md`](research/interaction-matrix.md).
>
> **Most of this document survives.** The recommendations that were adopted and are confirmed by our own
> data: lexical retrieval over vectors; auto-inject the digest rather than relying on self-recall;
> plan-as-state rather than plan-as-prompt; recite the plan at the tail; deterministic tool-result
> collapsing as the cheapest context win; no parallel coding subagents. Nothing found since argues
> against any of them.
>
> **Four specific claims are superseded. Do not follow them without reading the replacement.**
>
> 1. **Part 2's framing finding — "keep the LIVE context near the low-thousands of chars" (400–3 000
>    chars).** That probe was **Devstral**, and the same paragraph records that "Qwen3 was robust to
>    larger context; Devstral fragile". Argo now runs `qwen3.6` exclusively (H02, VALIDATED 4/4) and has
>    driven it correctly to **64 266 tokens of 65 536**. The target does not apply to the current model.
>    It survives in the code as `DEFAULT_EVICTION_BUDGET.maxLiveChars = 60 000` (~15 k tokens), which
>    sits **four times below** the 61 440-token compaction trigger — so the first time eviction takes the
>    threshold path it will stub essentially every evictable episode at once. See
>    [`research/01-context-management.md`](research/01-context-management.md) §3(d), §4(ii).
> 2. **Part 2 §D Tier 1 — "one small-model call extracts durable facts into the structured ledger".**
>    Built, and it wrote transcript sludge into the only `MEMORY.md` that exists: `Called bash({…})
>    Result: 2 passed, 3 failed`, twice, in a file re-injected every iteration. The design is not wrong
>    in principle; the implementation shares **one** extraction between in-run working memory and
>    cross-run durable knowledge, which are incompatible consumers. The simplest correct version is
>    *less* machinery, not more. See [`research/04-memory.md`](research/04-memory.md) — H15.
> 3. **Part 1's implicit optimism about self-critique as a convergence device.** The stronger result is
>    that LLMs cannot reliably self-correct reasoning without external feedback and sometimes degrade
>    after trying ([arXiv 2310.01798](https://arxiv.org/abs/2310.01798)), and same-model evaluators show
>    self-preference ([arXiv 2404.13076](https://arxiv.org/abs/2404.13076)). Ours agrees: Argo's Tester
>    has issued **0 REDOs in 85 frames** while reading a truncated self-report. The value is in
>    executable feedback, not second opinions. See
>    [`research/03-supervision-and-verification.md`](research/03-supervision-and-verification.md).
> 4. **Part 1's per-model tool-call handling advice (Qwen vs Devstral vs Llama templates).** Correct at
>    the time, now moot: H02 settled on one model, and multi-model support is not being pursued. Keep it
>    as background if the model ever changes.
>
> Two further corrections that touch documents citing this one: the Magentic-One "31 % from the ledger"
> figure is real but is the value of the **whole orchestrator**, not the ledger
> ([arXiv 2411.04468](https://arxiv.org/abs/2411.04468) §5.3); and the loop-guard advice below
> ("escalating steer is the right instinct") needs qualifying — Manus recommends a *nudge with variation*,
> and Argo *blocks*, with a measured desired effect in **6 of 143** blocks. See
> [`research/05-drift-and-loop-control.md`](research/05-drift-and-loop-control.md) — H19, H20.

---

# Getting Small/Local LLMs to Plan-Before-Implementing Without Losing Versatility

Research report for **Argo** (local-first coding-agent harness driving Ollama models: Qwen3, Qwen2.5-Coder, Mistral, Devstral, Llama 3.1, via a custom ReAct loop where a model turn with **no tool_call = final answer**).

Prepared: 2026-07-25. All non-obvious claims carry a source URL. Primary sources (official docs, papers, maintainer posts) preferred throughout.

---

## Executive summary (top takeaways for Argo)

1. **Every mature harness separates "figure out what to do" from "do it," but the separation that works for *weak* models is enforced by the *harness*, not by prompt wording.** Claude Code, Cline and Roo make plan mode a *tool-permission state* (files are read-only; edits are blocked)  not an instruction the model may forget ([Cline](https://docs.cline.bot/features/plan-and-act), [Claude Code](https://docs.anthropic.com/en/docs/claude-code/common-workflows)). Argo's bug  a plain-prose PLAN being treated as "done"  is exactly the failure that mode-as-state prevents. Argo should make "planning" a *loop state with different stop rules*, not a paragraph the model is asked to emit.

2. **Plan-as-file, recited into recent context, is the single best-evidenced anti-drift mechanism for long loops** and is model-agnostic. Manus deliberately maintains a `todo.md` and rewrites it every few steps to "recite objectives into the end of the context," explicitly to fight "drifting off-topic or forgetting earlier goals" over ~50-call loops ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Microsoft's Magentic-One formalizes the same idea as a **Task Ledger + Progress Ledger** with an explicit stall counter that triggers re-planning ([Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)). This directly attacks Argo's Problem 1 (90-iteration goal substitution).

3. **Planning must be conditional, or it destroys versatility.** Anthropic's own guidance: "If you could describe the diff in one sentence, skip the plan"; planning "adds overhead" and is only worth it for multi-file / unfamiliar / uncertain work ([Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). In all IDE harnesses (Cline/Roo/Claude Code) plan mode is *user-toggled*, not auto-forced. Argo needs a cheap gate so a simple Q&A or one-shot search never enters a planning phase.

4. **For local models the dominant failure modes are mechanical, not cognitive:** truncated context windows (Ollama's 2k default silently discards data  [Aider](https://aider.chat/docs/llms/ollama.html)), and models that "behave like a plain chatbot, refuse to use tools" ([OpenHands](https://docs.all-hands.dev/usage/llms/local-llms)). Fix these (large `num_ctx`, force a tool-call, agent-tuned models like Devstral) *before* adding planning cleverness.

**Recommended shape for Argo (detail in Design Options):** a lightweight *planning state* inside the single loop that (a) is entered only for non-trivial tasks via a cheap classifier, (b) is read-only, (c) **requires the plan to be written to a `PLAN.md` artifact via a tool call** (so "no tool call" can never be mistaken for "done" during planning), and (d) transitions to execution automatically once the artifact exists, with the plan re-injected/re-cited near the context tail. This is a hybrid of Cline's mode-as-state, Manus's recited plan-file, and Magentic-One's ledger  chosen because it needs no second model and survives the "no-tool-call = done" invariant.

---

## Per-system findings

### 1. Claude Code  "Plan mode"

**(a) How plan/act is mechanized.** Plan mode is a **permission mode**, not a prompt. It is entered with `claude --permission-mode plan` or by pressing **Shift+Tab** mid-session to cycle `default � acceptEdits � plan`; the status bar shows "� plan mode on." In plan mode "Claude reads files and proposes a plan but makes no edits until you approve" ([common-workflows](https://docs.anthropic.com/en/docs/claude-code/common-workflows)). The documented flow is explicit: **Explore** (enter plan mode; Claude "reads files and answers questions without making changes") � **Plan** ("create a detailed implementation plan"; user can open the plan in a text editor with Ctrl+G to edit before proceeding) � **Code** ("switch out of plan mode and let Claude code, verifying against its plan") ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)).

**(b) Grounding in the real codebase.** Grounding happens *during* the read-only explore phase  Claude reads relevant files first. Anthropic also recommends delegating research to sub-agents ("use subagents to investigate X") that "explore the codebase, read relevant files, and report back," keeping the main context clean for implementation ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). The critical anti-pattern they name is exactly Argo's Problem 2: planning before reading produces plans that "solve the wrong problem."

**(c) Convergence / stop.** Two mechanisms: (i) human approval gates the plan�code transition; (ii) verification against the plan  e.g., "review the & diff against PLAN.md," or a `/code-review` subagent that checks the diff in a fresh context ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)).

**(d) Sources.** https://docs.anthropic.com/en/docs/claude-code/common-workflows ; https://www.anthropic.com/engineering/claude-code-best-practices

### 2. Cline  "Plan" vs "Act" modes

**(a) Mechanization.** A dual-mode toggle. In **Plan mode** "Cline can read your codebase, run searches, and discuss strategy, but **cannot modify any files or execute commands**." In **Act mode** it "can now modify files, run commands, and execute your strategy." The constraint is described as "intentional & it keeps the conversation focused on understanding and planning" ([docs](https://docs.cline.bot/features/plan-and-act)). This is the clearest statement that the mode is a *capability restriction*, not advice.

**(b) Grounding.** "Let Cline explore relevant files and understand the codebase" is step 2 of the typical workflow; planning intentionally "builds context that Cline needs to implement changes effectively. Without it, Cline may lack the understanding required" ([docs](https://docs.cline.bot/features/plan-and-act)).

**(c) Convergence.** Transition is user-driven ("when confident in the plan, switch to Act mode"); full conversation history carries across the switch so no re-derivation is needed. Users "may cycle between modes multiple times," returning to Plan on "unexpected complexity"  a manual analog of Magentic-One's re-planning ([docs](https://docs.cline.bot/features/plan-and-act)).

**(d) Source.** https://docs.cline.bot/features/plan-and-act

### 3. Roo Code  modes (Architect / Ask / Code / Debug / Orchestrator)

**(a) Mechanization.** Roo generalizes Cline into named "modes" that are **tool-group permission sets**. Code mode: full access (`read, edit, command, mcp`). **Ask** mode: `read, mcp` only (cannot edit or run commands). **Architect** mode: `read, mcp, and restricted edit (markdown files only)`  i.e. it can write a plan document but not touch source ([docs](https://docs.roocode.com/basic-usage/using-modes)). Modes are switched via slash commands (`/architect`, `/code`, &), a keyboard toggle that cycles modes, or model-suggested switches.

**(b) Grounding.** Architect "follows a structured approach from information gathering to detailed planning" and has read access to the repo; markdown-only write access is precisely a plan-artifact mechanism ([docs](https://docs.roocode.com/basic-usage/using-modes)).

**(c) Convergence.** **Orchestrator / "Boomerang" mode** "breaks down complex tasks and delegates them to specialized modes"  a sub-agent decomposition where each subtask returns to the orchestrator ([docs](https://docs.roocode.com/basic-usage/using-modes)). Also notable for Argo: **sticky per-mode model selection**  each mode remembers its model, so a strong reasoning model can drive Architect and a cheaper model can drive Code ([docs](https://docs.roocode.com/basic-usage/using-modes))  Aider's architect/editor split done at the mode level.

**(d) Source.** https://docs.roocode.com/basic-usage/using-modes

### 4. Aider  "architect/editor" two-model separation + repo-map

**(a) Mechanization.** Aider splits a coding turn into two inference steps: an **Architect model** "is asked to describe how to solve the coding problem," then an **Editor model** "is given the Architect's solution and asked to produce specific code editing instructions" in the required edit format ([architect post](https://aider.chat/2024/09/26/architect.html)). Rationale: strong reasoning models (o1) reason well but "often fail to output properly formatted code edits," so separating "solve the problem" from "format the edits" lets each model do what it's good at ([architect post](https://aider.chat/2024/09/26/architect.html)). Aider also exposes plain modes  `/code`, `/ask` (discuss, never change), `/architect`  and a recommended "bounce between /ask and /code" workflow ([modes](https://aider.chat/docs/usage/modes.html)).

**(b) Grounding  the repo-map.** This is Aider's strongest transferable idea. Aider sends a **repository map**: "a list of the files & classes, methods and function signatures from everywhere in the repo," so "the LLM can see & everywhere in the repo & [and] figure out which files it needs to look at" ([repomap](https://aider.chat/docs/repomap.html)). For large repos it uses a **graph-ranking algorithm** over the dependency graph to select the most relevant portions within a token budget (`--map-tokens`, default 1k) ([repomap](https://aider.chat/docs/repomap.html)). This is a concrete way to ground a plan in the actual codebase *before* the model reads individual files  directly answering Argo's "planned before reading any file" defect.

**(c) Convergence.** The architect/editor split itself is a convergence device: the editor is constrained to *apply* the architect's proposal, reducing scope drift during the edit step. On the polyglot leaderboard, architect pairings (o1-preview + DeepSeek/o1-mini) set SOTA (~85%), but the "whole"-file edit format needed is "quite slow, so probably not practical for interactive use"  a cost warning ([architect post](https://aider.chat/2024/09/26/architect.html), [polyglot](https://aider.chat/2024/12/21/polyglot.html)).

**(d) Sources.** https://aider.chat/2024/09/26/architect.html ; https://aider.chat/docs/usage/modes.html ; https://aider.chat/docs/repomap.html ; https://aider.chat/2024/12/21/polyglot.html

### 5. OpenHands (OpenDevin)  CodeAct

**(a) Mechanization.** CodeAct consolidates all agent actions into **executable Python code as a single unified action space**, run through a Python interpreter, rather than emitting JSON tool calls per predefined tool. The interpreter lets the agent "dynamically revise prior actions or emit new actions upon new observations through multi-turn interactions" ([CodeAct paper](https://arxiv.org/abs/2402.01030)). Devstral is explicitly built to run "over code agent scaffolds such as OpenHands or SWE-Agent, which define the interface between the model and the test cases" ([Devstral](https://mistral.ai/news/devstral)).

**(b) Grounding.** Grounding is interactive: the agent runs code (grep, read files, run tests) and revises on observations. There is no static repo-map; grounding comes from executed exploration.

**(c) Convergence.** The CodeActAgent (fine-tuned Llama2/Mistral) is "tailored to & autonomously self-debug"  a reflection-via-execution loop where errors and stack traces feed the next action ([CodeAct paper](https://arxiv.org/abs/2402.01030)).

**(d) Sources.** https://arxiv.org/abs/2402.01030 ; https://docs.all-hands.dev/usage/llms/local-llms

### 6. SWE-agent  Agent-Computer Interface (ACI) design lessons

**(a) Mechanization.** SWE-agent's thesis: "LM agents represent a new category of end users & and would benefit from specially-built interfaces." They designed "simple LM-centric commands and feedback formats to make it easier for the LM to browse the repository, view, edit and execute code files"  the **ACI** ([paper abstract](https://arxiv.org/abs/2405.15793), [background](https://swe-agent.com/latest/background/)). The key lesson for Argo: *interface design, not just model quality, drives agent behavior*  "the design of the ACI can impact agents' behavior and performance" ([abstract](https://arxiv.org/abs/2405.15793)). Concretely this means guardrails (reject malformed edits, e.g. lint-check before applying), concise informative feedback, and paginated/bounded file views so weak models are not flooded.

**(b) Grounding.** Custom commands for repository navigation, viewing, and search designed to be legible to an LM (bounded output windows rather than dumping whole files).

**(c) Convergence.** Feedback formats that surface the result of each action clearly, so the model can course-correct  the interface reduces malformed-action loops.

**(d) Sources.** https://arxiv.org/abs/2405.15793 ; https://swe-agent.com/latest/background/

### 7. Manus / gptme  plan-as-file (`todo.md`)

**(a) Mechanization.** Manus "tends to create a `todo.md` fileand update it step-by-step as the task progresses, checking off completed items." This is "a deliberate mechanism to manipulate attention," not decoration ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

**(b) Grounding.** The plan file is grounded because it is built and maintained *during* execution and lives in the working directory alongside the code.

**(c) Convergence  the headline finding for Argo.** "A typical task in Manus requires around 50 tool calls on average & it's vulnerable to drifting off-topic or forgetting earlier goals, especially in long contexts." **"By constantly rewriting the todo list, Manus is reciting its objectives into the end of the context. This pushes the global plan into the model's recent attention span, avoiding 'lost-in-the-middle' issues and reducing goal misalignment"** ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Three further Manus lessons map onto Argo's existing guards:
- **"Keep the Wrong Stuff In."** Leaving failed actions + stack traces in context "shifts its prior away from similar actions, reducing the chance of repeating the same mistake." Erasing failures "removes evidence & the model can't adapt" ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **"Don't Get Few-Shotted."** Repetitive action-observation pairs make the model mimic the pattern, causing "drift, overgeneralization, or & hallucination"; the fix is deliberate **diversity** in serialization/phrasing. This is the theoretical justification for Argo's loop-steering guard (skip-identical-call + escalating steer) ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **"Mask, Don't Remove."** Rather than adding/removing tools, Manus uses a **context-aware state machine that masks token logits** to enforce/prevent certain actions per state  e.g. "when the user provides a new input, Manus must reply immediately instead of taking an action." Tool names share prefixes (`browser_`, `shell_`) so whole groups can be enabled/disabled by prefix ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). This is directly how a *planning state* can be enforced mechanically.

**(d) Source.** https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

### 8. Microsoft Magentic-One  Orchestrator with Task Ledger + Progress Ledger

**(a) Mechanization.** A lead **Orchestrator** runs **two nested loops**. The **outer loop** maintains a **Task Ledger** ("containing facts, guesses, and plan"); the **inner loop** maintains a **Progress Ledger** ("current progress, task assignment to agents") ([Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).

**(b) Grounding.** "The Orchestrator begins by creating a plan & gathering needed facts and educated guesses in a Task Ledger." Facts+guesses are the grounding substrate ([Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).

**(c) Convergence  directly targets Argo's Problem 1.** "At each step & the Orchestrator creates a Progress Ledger where it **self-reflects on task progress and checks whether the task is completed**." Crucially: **"If the Orchestrator finds that progress is not being made for enough steps, it can update the Task Ledger and create a new plan"**  an explicit **stall counter** that forces re-planning instead of grinding ([Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/); [paper](https://arxiv.org/abs/2411.04468)). Magentic-One is model-agnostic and mixes strong/weak models: "we recommend a strong reasoning model & for the Orchestrator" while other agents use cheaper models  relevant if Argo ever adds a planner sub-model ([Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).

**(d) Sources.** https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ ; https://arxiv.org/abs/2411.04468

---

## Comparison table

| System | Plan trigger | Read-only during plan? | Adaptive to task size? | Grounds plan in repo? | Convergence / stop mechanism |
|---|---|---|---|---|---|
| **Claude Code** | User: `--permission-mode plan` or Shift+Tab cycle | **Yes** (reads files, no edits) | Guidance only ("skip plan if 1-sentence diff"); user decides | Yes  read-only explore + subagent research | Human approval gate; verify diff vs PLAN.md; `/code-review` subagent |
| **Cline** | User toggles Plan�Act | **Yes** (no file edits, no commands) | Recommended by scenario table; user decides | Yes  explore files in Plan mode | User switch when confident; re-enter Plan on new complexity |
| **Roo Code** | Slash cmd / keyboard cycle / model suggestion; per-mode | **Architect/Ask: yes** (Ask read-only; Architect can write markdown only) | Mode-per-task; user or model-suggested | Yes  read access + info-gathering step | Orchestrator/Boomerang delegates & collects subtasks |
| **Aider (architect/editor)** | `/architect` or `--architect`; per-message or sticky | Ask mode read-only; architect proposes then editor applies | Manual mode selection | **Yes  repo-map (ranked, tree-sitter-style signatures)** | Editor constrained to apply architect's proposal; edit-format validation |
| **OpenHands / CodeAct** | Always-on ReAct-style code loop | No dedicated plan mode | No | Interactive (executes exploration code) | Self-debug via interpreter feedback |
| **SWE-agent** | Always-on ACI loop | No dedicated plan mode | No | Via LM-legible navigation commands | ACI guardrails + concise feedback reduce malformed loops |
| **Manus / gptme** | Automatic `todo.md` on complex tasks | No (executes) | Implicit (only complex tasks get todo.md) | Yes  file lives in workspace, updated live | **Recite todo.md into tail** + logit-mask state machine; keep failures in context |
| **Magentic-One** | Orchestrator plans at start | Planning is a reasoning step (no edits) | No explicit gate | Yes  Task Ledger (facts+guesses) | **Progress Ledger self-check + stall counter � re-plan** |

---

## Small / local-model findings (concrete, sourced)

**The bottleneck is usually mechanical, not intelligence.**

- **Context window truncation is the #1 silent killer.** Ollama "uses a 2k context window by default & and silently discards context that exceeds the window. This is especially dangerous because many users don't even realize that most of their data is being discarded" ([Aider Ollama docs](https://aider.chat/docs/llms/ollama.html)). Aider auto-sizes `num_ctx` to request+8k to avoid this. OpenHands is blunter: with Ollama, set `OLLAMA_CONTEXT_LENGTH` to **at least 22000**  "The default (4096) is way too small  not even the system prompt will fit, and the agent will not behave correctly"; 32768 recommended, with Flash Attention ([OpenHands local LLMs](https://docs.all-hands.dev/usage/llms/local-llms)). **Implication for Argo:** if planning adds a `PLAN.md` + full history + tool defs, a 2k/4k default guarantees the plan gets discarded and the model "forgets" the goal  the exact drift observed. Verify Argo sets a large `num_ctx`.

- **Small models "act like a chatbot" and refuse tools.** OpenHands: "If OpenHands behaves like a plain chatbot, refuses to use tools or files, or has constant failed tool calls & the issue may be with the model itself"; "even with a large context window, some local models may struggle with reliable tool use" ([OpenHands local LLMs](https://docs.all-hands.dev/usage/llms/local-llms)). **This is precisely Argo's Problem 2**  the model emitted prose (a plan) with no tool call. A weak model returning prose is the *default* behavior; the harness must force a tool call in states where prose alone is invalid.

- **Use agent-tuned models and expect scaffold-sensitivity.** Devstral is explicitly trained to run over agent scaffolds (OpenHands/SWE-agent) and scores 46.8% on SWE-Bench Verified, beating far larger models *under the same scaffold*, and runs on a single RTX 4090 / 32GB Mac ([Devstral](https://mistral.ai/news/devstral)). The lesson: agentic ability is co-trained with a scaffold; a model that drifts in Argo's loop may behave well in the loop it was trained for. Prefer Devstral/Qwen-Coder for the agentic role; Qwen2.5-Coder and Qwen3 are first-class local targets ([Qwen3](https://qwenlm.github.io/blog/qwen3/)).

- **Reasoning budget is now a dial  use it for the plan step only.** Qwen3 ships **hybrid thinking modes**: a "Thinking Mode" that reasons step-by-step "for complex problems," and a "Non-Thinking Mode" for "quick, near-instant responses & for simpler questions." `enable_thinking` toggles it, enabling "thinking budget control" ([Qwen3](https://qwenlm.github.io/blog/qwen3/)). **Implication:** Argo can enable thinking for the planning turn and disable it for trivial Q&A / simple edits  adaptive planning implemented at the *inference* layer, per model. (Qwen3's base context is 32K  respect it.)

- **Tool-call parsing is model-specific.** Qwen-Agent parses tool calls itself and adjusts its Function-Call template per model family (Qwen2.5 vs QwQ/Qwen3 vs Qwen3-Coder differ in whether to use the vLLM built-in `hermes` parser) ([Qwen-Agent](https://github.com/QwenLM/Qwen-Agent)). **Implication:** a single hard-coded tool-call format across qwen/devstral/llama will produce malformed calls on some models; Argo needs per-model tool-call handling or a tolerant parser.

- **What causes small models to drift/loop, and what mitigates it (synthesis):**
  - *Cause: repetitive context � few-shot mimicry.* Manus: identical action-observation pairs make models "fall into a rhythm & drift, overgeneralization, or & hallucination." *Mitigation:* inject diversity / vary phrasing  Argo's escalating steer is the right instinct ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - *Cause: goal falls out of recent attention over a long loop.* *Mitigation:* recite the objective near the tail (todo.md)  Manus's core anti-drift device ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  - *Cause: no definition-of-done to converge against* (Argo's 90-iteration run). *Mitigation:* Magentic-One's Progress Ledger self-check + stall counter forces re-plan/stop ([Microsoft](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).
  - *Cause: prose emitted instead of action.* *Mitigation:* mode-as-state that requires a tool call (Cline/Roo permissions; Manus logit-masking) ([Cline](https://docs.cline.bot/features/plan-and-act), [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

---

## Design options for Argo

Argo's hard constraints: **single local model**, **custom ReAct loop where a turn with no tool_call = final answer + auto-commit**, Docker-per-project, live streaming trace, and must stay versatile (a bare question or one-shot web search must not trigger heavyweight planning). Each option below is judged against these.

### Option A  The user's proposal: distinct planning PHASE that returns a plan, then an automated RESTART to execute

*Two separate runs: run 1 produces a plan (read-only); the harness then auto-starts run 2 with the plan injected to execute.*

- **Is it used in the wild?** The *phase separation* is universal (Claude Code/Cline/Roo all separate plan from act). The *automated restart with fresh context* is closest to Aider's architect�editor handoff and Claude Code's "delegate research to a subagent, then implement in main context" ([Claude best practices](https://www.anthropic.com/engineering/claude-code-best-practices), [Aider architect](https://aider.chat/2024/09/26/architect.html)). So the pattern has precedent  but always the plan is *carried across*, not thrown away.
- **Pros:** Clean separation makes the "no-tool-call = done" problem *disappear* for the planning run  plan run 1 is *expected* to end with prose (the plan) and that ending is the trigger to start run 2, so the current bug is actually *harnessed as a feature*. Read-only run 1 physically prevents thrash. Fresh context for run 2 avoids the "few-shot rut." Easy to stream as two visibly distinct phases in the trace UI.
- **Cons (Argo-specific):** (1) **Context loss / re-grounding cost**  if run 2 starts fresh it must re-read files the planner already read, wasting scarce local-model context and re-introducing the "plan before reading" risk unless the plan file carries file paths + findings. (2) **Double the cold-start** on a slow local model. (3) **Deciding *when* to run phase 1 at all** still requires an adaptive gate, or you've broken versatility. (4) The plan itself, produced by a weak model, may be generic (Argo's observed defect)  needs the read-only phase to actually read files first, i.e. it's not just "state a plan," it's "explore then write plan."
- **Verdict:** Workable and it neatly turns the fatal invariant into the transition signal  but the "restart with fresh context" variant is wasteful for local models. The **best version keeps a persistent plan artifact** so run 2 isn't blind. That converges toward Option C.

### Option B  Single loop with "plan, then immediately issue your first tool call"

*Prompt wording only: investigate, state a plan, then make a tool call in the same turn.*

- **Pros:** Zero architectural change; cheapest.
- **Cons (Argo-specific):** **This is what already failed.** Relying on wording is brittle across qwen/devstral/llama  weak models emit prose and stop, which the loop reads as done ([OpenHands: local models "act like a chatbot"](https://docs.all-hands.dev/usage/llms/local-llms)). No mechanism prevents the terminal-prose failure. **Reject as the primary mechanism**  but see the mechanical fix below.
- **Mechanical rescue (important):** Make it *impossible* to end via prose while planning by **forcing a tool call at the harness level**  Manus's "Mask, Don't Remove": in planning state, only allow the model to end by calling a `write_file`/`record_plan` tool; a no-tool-call turn during planning is treated as an error and re-prompted, **not** as "done" ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). If Argo's Ollama path supports tool-choice forcing or grammar/JSON-constrained output, use it; otherwise re-prompt on empty tool_calls while in planning state. This single change fixes Problem 2 without any phase split.

### Option C  Plan-artifact file the agent maintains and checks off (`PLAN.md` / `todo.md`)

*Single loop. On a non-trivial task the first required action is to write a `PLAN.md` (single concrete verifiable objective + steps). The loop re-injects/re-cites the plan near the context tail each iteration and the model checks items off.*

- **Is it used in the wild?** Yes  this is Manus's core mechanism and Magentic-One's ledger idea, and Roo's Architect mode literally has "write markdown only" permission ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus), [Microsoft](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/), [Roo](https://docs.roocode.com/basic-usage/using-modes)).
- **Pros (Argo-specific):** (1) **Writing the plan is a `write_file` tool call**, so planning *cannot* terminate the run  it fixes Problem 2 by construction and reuses Argo's existing tools. (2) **Recitation into the tail is the best-evidenced anti-drift device** and directly attacks Problem 1's goal-substitution over 90 iterations ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). (3) Single model, single loop  no restart, no context loss; the plan persists in the workspace and Docker. (4) A checklist gives a concrete **definition-of-done**: the run may only end (no-tool-call) once all `PLAN.md` items are checked *and* a verification step passed. (5) Streams beautifully  the trace UI can render the live todo list. (6) The plan file survives compaction (it's on disk, re-read cheaply).
- **Cons:** (1) Adds a tail-injection step to every iteration (cheap). (2) Weak models may not reliably re-check the boxes  needs a harness-side check, not a model self-check (see Option D's gate). (3) Must be gated so trivial tasks skip it (versatility).
- **Verdict:** **Strongest fit.** Reuses existing tools, respects the fatal invariant, and imports the two best-evidenced local-model anti-drift mechanisms (recitation + ledger).

### Option D  Separate planner sub-agent hands a plan to an executor

*Two roles (� la Aider architect/editor, Roo Orchestrator, Magentic-One): a planner model produces a plan; an executor model implements.*

- **Pros:** Cleanest cognitive separation; the executor is constrained to the plan (reduces scope drift). Proven at SOTA on Aider polyglot ([Aider architect](https://aider.chat/2024/09/26/architect.html)).
- **Cons (Argo-specific):** (1) **Argo is single-local-model**  the main payoff of the split (route reasoning to a strong model, editing to a cheap one) evaporates when both roles are the same 7-24B model. (2) Two models loaded in Ollama doubles VRAM or forces model-swapping latency. (3) Sub-agent orchestration is exactly the kind of ad-hoc complexity Argo's hand-written loop avoids. (4) Aider itself notes the strongest architect configs are "quite slow, not practical for interactive use" ([architect post](https://aider.chat/2024/09/26/architect.html)).
- **Verdict:** Over-engineered for a single-local-model harness. Revisit only if Argo later supports a distinct heavier planner model (then Qwen3 thinking-mode as planner, non-thinking as executor is a lightweight single-model approximation  see below).

### Recommendation

**Adopt Option C (plan-artifact + recitation) as the core, hardened with Option B's mechanical fix and Magentic-One's stall counter, entered via an adaptive gate.** Concretely:

1. **Adaptive gate (versatility).** Before planning, cheaply classify the task. Prefer a mechanical trigger over a model judgment where possible: skip planning for pure Q&A / single-shot web search / one-line edits ("if you could describe the diff in one sentence, skip the plan"  [Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)). If using Qwen3, express this as thinking-mode-on for planning tasks, off otherwise ([Qwen3](https://qwenlm.github.io/blog/qwen3/)). A tiny classifier prompt ("does this need a plan? yes/no") is acceptable but must fail *open* to no-plan to protect versatility.

2. **Planning state = read-only + must-write-plan.** On entering planning, (a) restrict edit/bash-write tools (Cline/Roo mode-as-state  [Cline](https://docs.cline.bot/features/plan-and-act)); (b) require the model to first read/grep real project files (Argo already has these tools) so the plan is grounded  mimic Aider's repo-map by injecting a file/symbol listing if cheap ([Aider repomap](https://aider.chat/docs/repomap.html)); (c) require the plan to be emitted as a `write_file` to `PLAN.md` with **one concrete, verifiable success criterion** (e.g., "reproduce energy H1e33, then show it bounded < X"). **A no-tool-call turn in planning state is re-prompted, never treated as done** ([Manus mask-don't-remove](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). This kills Problem 2.

3. **Execution state = same loop, plan recited at tail.** Continue the single loop. Each iteration, re-inject the current `PLAN.md` + checklist near the end of context (recitation  [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Keep failed attempts + tracebacks in context ("keep the wrong stuff in").

4. **Convergence gate = definition-of-done + stall counter.** The loop may only accept a no-tool-call "done" once the plan's success criterion is verified (ideally by an actual command/test run in Docker)  a verification-before-done gate. Add a Magentic-One-style stall counter: if N iterations pass with no checklist progress, inject a re-grounding step ("You are working on: <objective>. Have you reproduced the bug? If stalled, revise PLAN.md") and, past a threshold, force a re-plan rather than grinding ([Microsoft](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)). This kills Problem 1.

5. **Infra prerequisite (do first).** Ensure Ollama `num_ctx` is large (e22-32k) so `PLAN.md` + history + tools fit and are not silently truncated ([Aider](https://aider.chat/docs/llms/ollama.html), [OpenHands](https://docs.all-hands.dev/usage/llms/local-llms)). Prefer Devstral/Qwen-Coder for the agentic role and per-model tool-call parsing ([Devstral](https://mistral.ai/news/devstral), [Qwen-Agent](https://github.com/QwenLM/Qwen-Agent)).

**Why this over the user's pure two-phase restart (A):** it keeps one loop and one context (no re-grounding waste on a slow local model), turns the fatal "no-tool-call" invariant into a harness-enforced state rule rather than a phase boundary, and imports the two mechanisms with the strongest real-world evidence for weak-model drift (recitation + ledger/stall). If a phase split is still desired for trace clarity, implement it as Option A **but persist `PLAN.md` across the restart** so it degenerates into Option C anyway.

---

## What NOT to do

- **Don't rely on prompt wording to enforce plan-then-act on local models.** It already failed in Argo and is the documented weak-model failure ("acts like a chatbot," emits prose, no tool call  [OpenHands](https://docs.all-hands.dev/usage/llms/local-llms)). Enforce state mechanically (permissions / forced tool call), not by asking nicely.

- **Don't let the planning step end the run.** Any state where the model is *supposed* to think must have "no tool_call" mean "re-prompt," not "done + auto-commit." The plan must be an artifact written via a tool ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

- **Don't plan before reading the repo.** A plan listing "read index.html" as a *future* step is ungrounded and generic (Argo's observed defect; Anthropic's named anti-pattern  [best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). Reading/grep must precede plan-writing; inject a repo/symbol map if cheap ([Aider](https://aider.chat/docs/repomap.html)).

- **Don't force heavy planning on every task.** It "adds overhead" and destroys versatility; trivial tasks and pure Q&A must bypass it ([Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)). All IDE harnesses keep plan mode optional/user-toggled.

- **Don't add a second planner model just to get the architect/editor split.** With one local model the split's payoff vanishes and VRAM/latency costs are real; Aider itself flags the strongest architect configs as too slow for interactive use ([Aider](https://aider.chat/2024/09/26/architect.html)). Approximate it *within one model* via Qwen3 thinking-on-for-planning if needed ([Qwen3](https://qwenlm.github.io/blog/qwen3/)).

- **Don't scrub failed attempts / retries from context.** Removing failure "removes evidence" the model needs to stop repeating mistakes; keep tracebacks in context ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). (Compaction should summarize, not delete, failures.)

- **Don't let identical context accumulate  it induces mimicry loops.** Argo's skip-identical-call guard is correct; reinforce it with deliberate diversity in re-prompts rather than emitting the same steer verbatim ([Manus "Don't Get Few-Shotted"](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

- **Don't ship without fixing the context window.** A 2k/4k Ollama default silently discards the plan and history  no planning mechanism survives it ([Aider](https://aider.chat/docs/llms/ollama.html), [OpenHands](https://docs.all-hands.dev/usage/llms/local-llms)). This is a prerequisite, not an optimization.

- **Cargo-cult caution:** self-critique/"reflection" turns and "are you still on task?" re-grounding *do* help, but only when tied to a concrete criterion or a stall counter (Magentic-One's Progress Ledger checks completion against the ledger  [Microsoft](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)). A free-floating "reflect on your progress" prompt with no definition-of-done just burns tokens and, on weak models, can *manufacture* new sub-goals  the very drift you're trying to stop. Anchor every reflection to `PLAN.md`'s single verifiable objective and an executable check.

---

## Source list

- Claude Code  common workflows / plan mode: https://docs.anthropic.com/en/docs/claude-code/common-workflows
- Claude Code  best practices (explore�plan�code, adaptive planning, subagents): https://www.anthropic.com/engineering/claude-code-best-practices
- Cline  Plan & Act mode: https://docs.cline.bot/features/plan-and-act
- Roo Code  Using Modes (Architect/Ask/Orchestrator, tool-group permissions, sticky models): https://docs.roocode.com/basic-usage/using-modes
- Aider  Architect/Editor: https://aider.chat/2024/09/26/architect.html
- Aider  Chat modes: https://aider.chat/docs/usage/modes.html
- Aider  Repository map: https://aider.chat/docs/repomap.html
- Aider  Ollama (context window warning): https://aider.chat/docs/llms/ollama.html
- Aider  Polyglot leaderboard: https://aider.chat/2024/12/21/polyglot.html
- OpenHands / CodeAct paper: https://arxiv.org/abs/2402.01030
- OpenHands  Local LLMs (context size, "acts like a chatbot"): https://docs.all-hands.dev/usage/llms/local-llms
- SWE-agent  ACI paper: https://arxiv.org/abs/2405.15793 ; background: https://swe-agent.com/latest/background/
- Magentic-One  Microsoft Research article (Task/Progress Ledger, stall�re-plan): https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ ; paper: https://arxiv.org/abs/2411.04468
- Manus  Context Engineering lessons (todo.md recitation, keep-wrong-stuff-in, don't-get-few-shotted, mask-don't-remove): https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Mistral  Devstral (agent scaffolds, local deployment): https://mistral.ai/news/devstral
- Qwen-Agent (per-model tool-call parsing): https://github.com/QwenLM/Qwen-Agent
- Qwen3  hybrid thinking modes / thinking budget: https://qwenlm.github.io/blog/qwen3/

---

# Agent Memory & Context-Management for Small, Local Coding Models
### A sourced research report for **Argo** (local-first ReAct harness on Ollama; Qwen3 2432B, Devstral/Mistral 24B, Llama 3.1, Qwen2.5-Coder)

*Framing finding (internal, empirical): direct Ollama probes show that **total live-context size is the dominant driver of small-model reliability**. At ~4003000 chars these models emit clean native tool calls and act step-by-step; by ~7k and definitely ~12k chars, Devstral stops emitting native tool calls  it narrates the action as prose or writes the call as XML in the message body, and stalls. Temperature (0.2 vs 0.8) did not matter; size did. Qwen3 was robust to larger context; Devstral fragile. Design goal: keep the LIVE context extremely lean and externalize the rest so the model can reach back on demand.*

This report evaluates seven borrowed mechanisms against three hard constraints: **small local model + lean (no heavy deps) + a single hand-written loop.** Every non-obvious claim is cited; the internal probe result above is treated as ground truth for Argo.

---

## Executive summary (highest-leverage takeaways)

1. **Leanness is not a preference  it is the mechanism.** Anthropic's own guidance reduces to "find the smallest set of high-signal tokens that maximize the likelihood of the outcome," because attention is a finite budget and precision degrades as context grows ([Anthropic, *Effective context engineering*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). "Lost in the Middle" shows even long-context models fail to use mid-context information ([Liu et al. 2023](https://arxiv.org/abs/2307.03172)). Argo's probe result is the same phenomenon, amplified on 2432B models. **Everything below serves the goal of a tiny live context.**

2. **Externalize to the file system, not a vector DB.** Manus treats the file system as "the ultimate context& unlimited, persistent, directly operable," and makes every compression *restorable* (drop a web page's body, keep its URL/path) ([Manus, 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Anthropic ships the same idea as the file-based **memory tool** ([Anthropic, 2025](https://www.anthropic.com/news/context-management)). This is lean, transparent, and grep-able  a perfect fit for Argo.

3. **Use lexical/structural retrieval (grep/ripgrep + a repo map), not embeddings.** Cline deliberately does **not** index or embed codebases  it explores file-by-file with keyword/structural tools, arguing chunked embeddings tear code apart, indexes decay, and vectors double the security surface ([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)). Claude Code uses `glob`/`grep` just-in-time to bypass stale indexing ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)); Aider uses a tree-sitter, graph-ranked repo map ([Aider](https://aider.chat/docs/repomap.html)). **A vector store does not earn its weight for Argo.**

4. **Recite the plan; keep failures; avoid uniform few-shot ruts.** Manus's `todo.md` recitation pushes the goal into recent attention to fight drift over ~50-tool-call loops; keeping error traces in-context reduces repeat mistakes; over-uniform context induces mimicry/looping ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). These are prompt-shape changes, zero new dependencies  the cheapest reliability wins available to Argo.

5. **Do not trust small models to self-page memory; auto-inject a tiny digest and *offer* (don't require) a recall tool.** MemGPT/Letta's self-directed paging depends on strong function-calling  GPT-3.5 already collapses on nested memory lookups ([MemGPT](https://ar5iv.labs.arxiv.org/html/2310.08560)) and Letta explicitly warns "weaker models can cause the agent to behave in unexpected ways" ([Letta docs](https://docs.letta.com/guides/server/providers/ollama)); even capable models score 3767% on Letta's self-managed-memory leaderboard ([leaderboard.letta.com](https://leaderboard.letta.com)). Argo's probe shows small models already fail to reach for tools as context grows  so **the harness must own retrieval of the always-needed state.**

---

## Per-technique findings

### 1. MemGPT / Letta  "LLM-as-OS", memory blocks, self-directed paging

**Mechanics.** MemGPT casts the LLM as an OS managing a memory hierarchy: a fixed **main context** (the prompt window) plus **external context** (recall storage = message DB; archival storage = searchable long-term store). The LLM moves data between tiers *itself* by emitting **function calls** (e.g., page a query's results into main context, evict/append), using interrupts for control flow ([MemGPT abstract](https://arxiv.org/abs/2310.08560); [full paper](https://ar5iv.labs.arxiv.org/html/2310.08560)). Letta (the productized successor) exposes **memory blocks**: labeled, size-limited, always-visible sections prepended to the prompt in an XML-like format (`<persona>`, `<human>`, custom blocks like `scratchpad`/`task_state`), which the agent reads/writes via built-in memory tools; blocks can be read-only or shared across agents ([Letta docs](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)).

**Evidence on small/local models.** The whole system is **gated on function-calling quality.** In the paper's nested key-value task, GPT-3.5 hits **0% at one nesting level** because it fails to chain enough lookups; even GPT-4 Turbo/3.5 drop off, and only GPT-4 is robust ([full paper](https://ar5iv.labs.arxiv.org/html/2310.08560)). Letta's own docs: "We recommend first-time users use a large frontier model& since **weaker models can cause the agent to behave in unexpected ways**" ([Letta/Ollama docs](https://docs.letta.com/guides/server/providers/ollama)). Letta's memory-management leaderboard shows the difficulty concretely  frontier models 8493%, but `gpt-5-mini` 67%, `claude-haiku` 43%, open-weights (`glm-5` 39%, `minimax-m2.5` 37%) ([leaderboard.letta.com](https://leaderboard.letta.com)). Memory *self-management* is exactly where small models are weakest.

**Pitfalls for weak models.** (a) Self-paging requires reliably emitting native tool calls under growing context  precisely Argo's failure mode. (b) Nested/sequential memory ops (search � page � decide � search again) compound failure. (c) The XML-like block wrapper is fine, but relying on the model to *decide when* to edit blocks is fragile.

**Transfer verdict  PARTIAL.** *Steal the data model, reject the autonomy.* The **memory-block idea** (a small, labeled, always-visible, harness-managed state section) is excellent and lean. The **self-directed paging** (model calls functions to move memory in/out) is the wrong bet for Devstral/Qwen-class models. In Argo, the harness  not the model  should own when blocks are populated and injected.

---

### 2. Manus  file system as external memory + `todo.md` recitation

**Mechanics.** Manus offloads bulky observations (web pages, PDFs, tool dumps) to files and keeps only a **restorable reference** in context (URL, sandbox path) so content can be re-read on demand  "the file system as the ultimate context: unlimited in size, persistent, and directly operable." Compression is **always designed to be restorable** so nothing is irreversibly lost ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). For long loops (avg ~50 tool calls), Manus writes and **continually rewrites a `todo.md`**, checking off items  deliberately "reciting objectives into the end of the context" to bias recent attention toward the goal and dodge "lost-in-the-middle" drift. Two related lessons: **"Keep the Wrong Stuff In"**  leaving failed actions + stack traces in context shifts the model's prior away from repeating them; and **"Don't Get Few-Shotted"**  uniform action/observation patterns cause mimicry, drift, and hallucination, so inject small structured variation.

**Reported effect on drift.** These are presented as the specific fixes for goal misalignment over long tasks, validated "across millions of users" ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). The recitation mechanism directly counters the position-bias documented in [Lost in the Middle](https://arxiv.org/abs/2307.03172).

**Transfer verdict  STRONG / ADOPT.** This is the leanest, most directly applicable body of advice for Argo. File-as-memory needs only file tools Argo already has; restorable references keep the live context tiny; recitation and "keep failures in" are pure prompt-shaping (zero dependencies). *Caveat:* recitation itself consumes context, so the todo/plan block must stay short and live at the **end** of the prompt. The KV-cache advice (stable prefix, append-only) also transfers to Ollama/llama.cpp prefix caching and is worth honoring.

---

### 3. Anthropic (2025)  memory tool + context editing + context-engineering guidance

**Mechanics.**
- **Memory tool:** a file-based store under `/memories`; Claude issues tool commands (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) that *your* application executes against storage you control (client-side). The model checks memory before a task and reads files back on demand ([memory-tool docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool); [announcement](https://www.anthropic.com/news/context-management)).
- **Context editing:** server-side automatic clearing of **stale tool results** (`clear_tool_uses_20250919`) and thinking blocks once context crosses a token threshold, preserving conversation flow  "why would the agent need to see the raw result again?" ([context-editing docs](https://docs.claude.com/en/docs/build-with-claude/context-editing); [Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Guidance:** context = a finite attention budget; aim for the **smallest set of high-signal tokens**; prefer **just-in-time** retrieval (lightweight identifiers loaded on demand) over pre-indexing; Claude Code uses a **hybrid**  `CLAUDE.md` dropped in up front, `glob`/`grep` for the rest ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Evidence.** On an internal agentic-search eval, **memory tool + context editing = +39%** over baseline; **context editing alone = +29%**; a 100-turn web-search task that otherwise failed on context exhaustion completed with **84% fewer tokens** ([Anthropic, 2025](https://www.anthropic.com/news/context-management)). Note these numbers are on Claude Sonnet 4.5 (a frontier model with "built-in context awareness"), not small local models.

**Transfer verdict  MIXED; adopt the ideas, not the model-driven versions.** *Context editing (tool-result clearing)* is high-value and transfers cleanly: Argo can deterministically drop or collapse old tool outputs to a one-line stub + path, no model cooperation required  and this is exactly what keeps the live context small. The *memory tool* is the same file-as-memory pattern from Manus and is fine, but Argo should not depend on the model reliably issuing `view`/`str_replace` at the right moment (same function-calling fragility as MemGPT). The **"smallest set of high-signal tokens"** principle and **just-in-time grep/glob** philosophy are the north star and cost nothing.

---

### 4. Retrieval over past work  lexical (BM25/grep/ripgrep) vs vector embeddings

**Mechanics.** Lexical/structural: `ripgrep`/`grep` keyword search, plus a **repo map**  Aider parses the repo with **tree-sitter** and ranks symbols/files with a **graph algorithm (PageRank-style)** to fit a token budget, then lets the LLM ask for specific files ([Aider repomap](https://aider.chat/docs/repomap.html)). Vector: chunk � embed � store in a vector DB � nearest-neighbor retrieve.

**Practitioner evidence (strong, primary).** **Cline explicitly refuses to index/embed the codebase.** Their reasoning: (1) **code doesn't chunk**  a call is in one chunk, its definition in another, its rationale scattered; "naive chunking& struggle[s] with& meaningful segments of code"; (2) **indexes decay** while code changes, so the agent "confidently suggests calling functions that no longer exist"; (3) embeddings **double your security surface** (a second copy of your IP). Instead Cline does "**Discovery, Not Retrieval**": reads a file, follows its imports, builds connected understanding  "No index. No embeddings& just intelligence applied directly to your code" ([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)). Anthropic concurs that agentic `glob`/`grep` "bypass[es] the issues of stale indexing," and that embedding-based pre-retrieval is giving way to just-in-time strategies ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**The key caveat for small models.** Cline's method works because the *model* is strong enough to explore intelligently. A small local model may explore poorly, chase dead-ends, or fail to follow imports  Anthropic notes runtime exploration is slower and "without proper guidance, an agent can waste context& chasing dead-ends" ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). This argues for a **hybrid**: harness-provided structure (a small repo map / symbol index built with `ripgrep`/`ctags`/tree-sitter, dropped in up front like `CLAUDE.md`) **plus** grep tools  so the model doesn't have to discover structure from scratch, and still doesn't need embeddings.

**Transfer verdict  ADOPT LEXICAL; REJECT VECTORS.** For a lean, local coding agent the evidence is one-sided: grep/ripgrep + a cheap structural map beats a vector store on freshness, transparency, security, and dependency weight. A vector DB + embedding model would add a service, RAM/CPU cost, an indexing pipeline, and staleness  and buys little when the corpus is a *local, changing codebase* the agent can read directly. **Do not add a vector store.**

---

### 5. Cheaper / faster summarization & compaction

**Current Argo cost:** 2 big-model calls per compaction (update + validate)  slow, CPU-heavy.

**Reported techniques & evidence.**
- **Recursive / hierarchical summarization:** summarize small sections, then summarize the summaries. OpenAI's *Recursively Summarizing Books* demonstrated book-length summarization via recursive task decomposition ([Wu et al. 2021](https://arxiv.org/abs/2109.10862)). Applies to long agent traces: roll up per-step notes into per-phase summaries into a running project summary.
- **Compaction as summarize-and-reinitiate:** Claude Code passes message history to the model to summarize, **preserving architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs**, then continues with the summary **plus the 5 most-recently-accessed files** ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Tuning advice: **maximize recall first, then trim for precision.**
- **Cheapest lever = deterministic tool-result clearing (no LLM call at all):** "once a tool has been called deep in the message history, why would the agent need to see the raw result again?"  "the safest, lightest touch form of compaction." This is a pure code operation ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [context-editing docs](https://docs.claude.com/en/docs/build-with-claude/context-editing)).
- **Structured (non-prose) state:** Manus's `todo.md` and Letta's labeled blocks are structured state, not prose narratives  cheaper to produce, easier to validate, and more stable in context ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus); [Letta](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)).
- **A dedicated small model for compression:** Cognition runs "a new LLM model whose key purpose is to compress a history of actions & conversation into key details, events, and decisions," and notes they even **fine-tuned a smaller model** for this ([Cognition](https://cognition.ai/blog/dont-build-multi-agents)).

**Transfer verdict  ADOPT, restructured.** For Argo, in priority order: (1) **Deterministic tool-result clearing/collapsing**  drop the biggest cost with zero LLM calls; keep a one-line stub + path so it's restorable (Manus principle). (2) **Summarize only durable facts into a structured ledger** (decisions, open bugs, file�purpose map, next steps) rather than prose  one small/fast-model call, not two big-model calls; **drop the separate "validate" pass** (structured schema + keeping raw traces on disk makes validation cheap/unnecessary). (3) **Route summarization to a smaller/faster local model** (e.g., a 78B) off the critical path if it holds quality on extraction-style tasks. (4) **Recursive roll-ups** only for very long tasks. The "async/background" idea is attractive but adds concurrency complexity to a single loop  treat as optional.

---

### 6. Self-recall vs auto-inject (PIVOTAL for Argo)

**Question:** do small models reliably call a recall tool when they need memory, or must the harness auto-inject?

**Evidence that self-recall is fragile.** This is the crux where the sources converge against small models:
- MemGPT's self-paging **collapses without strong function-calling** (GPT-3.5 � 0% on nested lookups) ([MemGPT](https://ar5iv.labs.arxiv.org/html/2310.08560)).
- Letta warns weaker models "behave in unexpected ways" and its memory-management leaderboard shows even `gpt-5-mini`/`haiku`/open-weights at 3767% ([Letta docs](https://docs.letta.com/guides/server/providers/ollama); [leaderboard](https://leaderboard.letta.com))  i.e., *deciding when and what to remember/recall* is hard even above Argo's weight class.
- Function-calling reliability itself is model- and context-dependent; BFCL evaluates exactly this (including multi-turn and hallucinated/irrelevant-call detection), and small open models trail ([BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)).
- **Argo's own probe** is the decisive local evidence: as context grows, Devstral stops emitting native tool calls at all. A model that won't reliably call *any* tool cannot be trusted to call a *recall* tool at the right moment.

**Evidence for auto-inject / hybrid.** Anthropic's Claude Code **auto-injects `CLAUDE.md` up front** (always-on context) and *also* offers grep/glob for on-demand pulls  an explicit **hybrid** ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Letta memory blocks are "**always visible  no retrieval needed**," i.e., auto-injected by construction ([Letta](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)). Anthropic's memory tool auto-checks memory before a task ([memory-tool docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)). The pattern that works: **the small, always-needed state is auto-injected; bulky/optional detail is left on disk behind a recall tool.**

**Transfer verdict  AUTO-INJECT the digest; OFFER (don't rely on) recall.** For Argo: the harness must always inject a tiny, structured **live digest** (current plan/todo, key decisions, file�purpose map, last error)  never assume the model will fetch it. Additionally offer a `recall`/`grep`/`read_file` tool for detail. Do **not** build a design whose correctness depends on the model choosing to recall.

---

### 7. Making SMALL local models complete long multi-step tasks (2025 state of the art)

Synthesis of what's reported to help, all context-management-wise and all applicable to a lean single loop:
- **Minimal live context** is the dominant factor (Anthropic's "smallest set of high-signal tokens"; [Lost in the Middle](https://arxiv.org/abs/2307.03172); Argo's probe). Everything else is downstream of this.
- **Plan recitation / task ledger** at the end of the prompt to fight drift over long loops (Manus `todo.md`) ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Keep failures in-context** (compressed: action + error) to prevent repeat mistakes; **inject variation** to avoid few-shot mimicry loops ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Deterministic context editing** (clear/collapse stale tool results) to hold the window small over many turns ([Anthropic](https://www.anthropic.com/news/context-management)).
- **Restorable externalization** to files so nothing bulky lives in-context but everything is recoverable ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
- **Verification gates:** a coding agent should close each step against a test/lint result rather than the model's self-assessment (implied by "keep the wrong stuff in" + Argo's need to avoid hallucinated success). Cheap and high-leverage for local models.
- **Sub-agent context isolation for read-only investigation** (topic 8), used judiciously.
- **Structured, harness-owned state** rather than model-managed memory (topics 1, 6).

The through-line: **the harness does the memory/context management; the model just takes the next step against a small, freshly-curated window.**

---

### 8. Sub-agent / context-isolation patterns

**Mechanics.** A fresh-context sub-run explores/searches, then returns only a **condensed summary** (Anthropic reports subagents burning tens of thousands of tokens internally but returning **~1,0002,000 tokens** to the lead), keeping the main context clean ([Anthropic ctx-eng](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Anthropic's multi-agent research system had **Opus lead + Sonnet subagents outperform single-agent Opus by 90.2%** on their internal research eval, and found **token usage alone explains ~80% of performance variance**  sub-agents mainly help by *spending more tokens in parallel with separate context windows* ([Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)).

**Critical counter-evidence.** The wins are for **breadth-first research**, not coding. Anthropic themselves: "most coding tasks involve fewer truly parallelizable [sub]tasks& agents are not yet great at coordinating," and multi-agent systems burn **~15� the tokens** of a chat ([Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)). Cognition's *Don't Build Multi-Agents* is blunt: parallel subagents make **conflicting implicit decisions** and produce inconsistent output ("build a Flappy Bird clone" � mismatched bird and background); their principles are **"share context / share full agent traces"** and **default to a single-threaded linear agent**. They note Claude Code's subagent (as of mid-2025) **only answers questions, never writes code, and never runs in parallel**, precisely because a subagent lacks the main agent's context  its sole benefit is keeping investigation out of the main history ([Cognition](https://cognition.ai/blog/dont-build-multi-agents)).

**Transfer verdict  ADOPT NARROWLY (read-only investigation only).** The valuable, low-risk pattern for Argo: spawn a **fresh-context sub-run to investigate a bounded question** ("where is X handled? summarize how auth works") and return a short summary into the main context  this keeps the main window lean and matches Claude Code's actual usage. **Do NOT** run parallel coding subagents that make edits: token-hungry, coordination-heavy, and the conflicting-decisions failure mode is worst for small models that already misinterpret instructions (Cognition observed even a *large*�*small* model hand-off failing on "slight ambiguities"). Keep Argo single-threaded for anything that writes code.

---

## Recommended memory architecture for Argo

**Design principle:** *The harness manages memory; the model only takes the next step against a tiny, freshly-curated window.* No vector DB. No service. Files + grep + one small structured state block.

### A. What lives in the tiny LIVE context (target: keep it near the low-thousands of chars)
1. **System prompt**  minimal, stable prefix (protect KV-cache; no per-second timestamps) ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
2. **Tool schemas**  a *small, non-overlapping* set. Don't add/remove tools mid-task (breaks cache; confuses the model)  mask/gate instead ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
3. **The Ledger (auto-injected, structured, small):** current goal, `todo` with checkboxes, key decisions, a compact `file � purpose` map for touched files, and the **last error** (if any). Placed at the **end** of the prompt for recency (recitation) ([Manus](https://manus.im/blog/...); [Lost in the Middle](https://arxiv.org/abs/2307.03172)).
4. **Recent turns only**  last N action/observation pairs, with **older tool results collapsed to a one-line stub + restorable path** (deterministic context editing) ([Anthropic](https://www.anthropic.com/news/context-management)).

### B. What is externalized to files (restorable, grep-able)
- Full tool outputs, file reads, web fetches � written to `.argo/` (or sandbox paths); context keeps only the path/handle ([Manus](https://manus.im/blog/...); [Anthropic memory tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)).
- The durable ledger/notes � a file that survives compaction and sessions.
- A **repo map** (symbols + file�purpose), built once with `ripgrep`/tree-sitter/`ctags`, refreshed on file change  dropped in like `CLAUDE.md` for coding tasks.

### C. Retrieval  **lexical/structural, chosen deliberately over vectors**
- Primary: `ripgrep`/`grep` + `read_file` + the repo map (just-in-time, always fresh) ([Cline](https://cline.ghost.io/...); [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [Aider](https://aider.chat/docs/repomap.html)).
- **Justification for no vector store:** the corpus is a local, mutating codebase the model can read directly; embeddings add a model + service + indexing pipeline + staleness + a second copy of the IP, and buy little over grep for a *lean* agent ([Cline](https://cline.ghost.io/...)). If future evidence shows lexical recall failing on large repos, revisit  but start lexical.
- **Hybrid for weak models:** because small models explore worse than Claude, give them *structure up front* (the repo map) so grep is guided, not blind.

### D. Summaries  produced cheaply
- **Tier 0 (no LLM):** deterministically collapse stale tool results to stub+path. Do this every turn; it's the biggest, cheapest win ([Anthropic](https://www.anthropic.com/news/context-management)).
- **Tier 1 (one small-model call):** when the window crosses a threshold, extract **durable facts into the structured ledger schema** (decisions, open bugs, file map, next step)  recall-first prompt. **Drop the second "validate" call**; the structured schema plus raw traces retained on disk make a separate validation pass unnecessary. Route to a smaller/faster local model if it holds quality.
- **Tier 2 (rare):** recursive roll-up of phase summaries for very long tasks ([Wu et al.](https://arxiv.org/abs/2109.10862)).

### E. Auto-inject vs self-recall
- **Auto-inject** the ledger every turn (never rely on the model to fetch its own plan/state)  this is the pivotal decision, grounded in Argo's probe + MemGPT/Letta fragility ([MemGPT](https://ar5iv.labs.arxiv.org/html/2310.08560); [Letta](https://docs.letta.com/guides/server/providers/ollama); [leaderboard](https://leaderboard.letta.com)).
- **Offer** `grep`/`read_file`/`recall` tools for optional detail  but correctness must not depend on the model choosing to call them.

### F. Staying on-plan (anti-drift)
- **Recite** the todo/plan at prompt end each turn ([Manus](https://manus.im/blog/...)).
- **Keep compressed failures** in context; **vary** serialization slightly to avoid mimicry loops ([Manus](https://manus.im/blog/...)).
- **Verification gate:** after each edit, run tests/lint and feed the (short) result back; treat a green gate  not the model's prose  as "done."
- **Read-only sub-run** for bounded investigations, returning a ~12k-char summary; single-threaded for all edits ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents); [Cognition](https://cognition.ai/blog/dont-build-multi-agents)).

---

## What NOT to do

- **Don't add a vector database / embedding model.** Weight, staleness, security surface, and poor fit for code  grep + repo map wins for a lean local agent ([Cline](https://cline.ghost.io/...); [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Don't rely on the model to self-page / self-recall memory.** It's the failure mode of small models under load ([MemGPT](https://ar5iv.labs.arxiv.org/html/2310.08560); [Letta](https://docs.letta.com/guides/server/providers/ollama); Argo probe).
- **Don't run parallel coding subagents.** Conflicting implicit decisions, 15� tokens, worst on small models ([Cognition](https://cognition.ai/blog/dont-build-multi-agents); [Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Don't add/remove tools mid-task or inject per-second timestamps.** Breaks KV-cache and confuses the model into schema violations/hallucinated actions ([Manus](https://manus.im/blog/...)).
- **Don't over-compress irreversibly.** Aggressive prose summaries lose context whose importance surfaces later; keep compression *restorable* ([Manus](https://manus.im/blog/...); [Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Don't scrub failures from the trace.** "Erasing failure removes evidence& the model can't adapt" ([Manus](https://manus.im/blog/...)).
- **Don't fill context with uniform few-shot examples.** Induces mimicry/looping in agent loops ([Manus](https://manus.im/blog/...)).
- **Don't keep 2 big-model calls per compaction.** Replace with Tier-0 deterministic clearing + one small-model structured extraction.

---

## Experiments to run (measurable on a coding task with a test suite)

Metric backbone for all: **task success (test-suite pass), tool-call validity rate (native vs prose/XML), turns-to-completion, total tokens/wall-clock, live-context size distribution, loop/drift incidents.** Run each on Devstral 24B (fragile) and Qwen3 (robust) to see if effects are model-dependent.

1. **Live-context cap (headline A/B).** Fixed harness, vary max live-context (3k / 7k / 12k+ chars) via more/less aggressive externalization. *Predicts:* success and tool-call validity fall as live context grows, steeper for Devstral. Validates the framing finding and sets Argo's cap.
2. **Lexical vs vector retrieval.** grep + repo map **vs** an embedding+vector-store recall tool, same tasks. Measure success, retrieval precision, staleness bugs (calls to non-existent symbols), setup/latency cost. *Hypothesis:* lexical e vector for the leanness cost  justify or refute keeping vectors out.
3. **Auto-inject digest vs self-recall.** (a) harness auto-injects the ledger every turn vs (b) model must call `recall`. Measure how often the model actually recalls, and downstream drift/success. *Hypothesis:* self-recall underperforms and under-fires on small models.
4. **Compaction cost/quality.** Current 2�big-model vs (i) Tier-0 clearing only, (ii) Tier-0 + one small-model structured extraction, (iii) recursive roll-up. Measure success, post-compaction continuity (does it repeat solved work / drop open bugs?), and CPU/latency. *Target:* match quality at a fraction of cost, no validate pass.
5. **Recitation on/off.** Toggle the end-of-prompt todo recitation on a long (~3050 step) multi-file task. Measure goal-drift incidents and off-plan actions. *Hypothesis:* recitation reduces drift, especially past ~7k context.
6. **Keep-failures & anti-mimicry.** A/B keeping compressed error traces vs scrubbing them; and uniform vs slightly-varied serialization. Measure repeat-mistake rate and loop incidents.
7. **Read-only investigation sub-run.** For tasks needing codebase understanding, A/B a fresh-context sub-run returning a 12k-char summary vs inline exploration in the main loop. Measure main-context size, success, and tokens. *Hypothesis:* sub-run keeps main context leaner without hurting success; parallel *editing* subagents (if tested) hurt.
8. **Verification gate.** A/B feeding test/lint results back after each edit vs trusting model self-report. Measure hallucinated-success rate and final pass rate.

---

## Sources
- MemGPT: *Towards LLMs as Operating Systems*  https://arxiv.org/abs/2310.08560 � full text https://ar5iv.labs.arxiv.org/html/2310.08560
- Letta  Memory blocks  https://docs.letta.com/guides/core-concepts/memory/memory-blocks � Local/Ollama models & weak-model warning  https://docs.letta.com/guides/server/providers/ollama � Memory leaderboard  https://leaderboard.letta.com
- Manus  *Context Engineering for AI Agents: Lessons from Building Manus*  https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Anthropic  *Effective context engineering for AI agents*  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic  *Managing context on the Claude Developer Platform* (memory tool + context editing; +39%/+29%/84%)  https://www.anthropic.com/news/context-management
- Anthropic  *How we built our multi-agent research system* (90.2%; tokenH80% variance; 15�)  https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic docs  Memory tool  https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool � Context editing  https://docs.claude.com/en/docs/build-with-claude/context-editing
- Cline  *Why Cline Doesn't Index Your Codebase*  https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/
- Aider  Repository map (tree-sitter + graph ranking)  https://aider.chat/docs/repomap.html
- Cognition (Walden Yan)  *Don't Build Multi-Agents*  https://cognition.ai/blog/dont-build-multi-agents
- Liu et al.  *Lost in the Middle: How Language Models Use Long Contexts*  https://arxiv.org/abs/2307.03172
- Wu et al. (OpenAI)  *Recursively Summarizing Books with Human Feedback*  https://arxiv.org/abs/2109.10862
- Berkeley Function Calling Leaderboard (BFCL)  https://gorilla.cs.berkeley.edu/leaderboard.html
