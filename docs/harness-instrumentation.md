# How the Argo harness instruments the LLM

Argo runs a **local** language model (currently `qwen3.6`) in a loop: the model thinks,
calls tools (read/edit files, run commands, fetch pages), sees the results, and repeats
until it produces a final answer with no tool call. On its own a small local model drifts,
loops, forgets the goal, and claims work is done when it isn't. The **harness** is the
scaffolding around that loop that keeps it on track. This document explains every piece of
that scaffolding in plain terms, what it's for, and an honest take on how well it works —
no prior context needed.

## How to read the status tags
Each behavior is tagged:
- **always on** — part of the baseline loop, cannot be turned off.
- **on by default** — enabled out of the box; can be turned off with an environment variable.
- **optional** — built but off by default (unproven or costly); turned on with an env var or the UI.

The environment flags: `ARGO_TASKS`, `ARGO_MEMORY`, `ARGO_LOOP` (all **on**, set to `0/false/off`
to disable), `ARGO_GROUNDING` (**on**), `ARGO_CRITIC` (**off**), `ARGO_LAYOUT` (**off**),
`ARGO_AUTOCOMMIT` (**off**). Source: `src/config.ts`.

---

## 1. Making it plan  *(always on)*

**What it does.** Before the model is allowed to change your project, it has to say what it's
going to do. It can freely read files, search, and answer questions, but the first time it
tries to *edit or write a file* in the project, the harness stops it and says: "record a plan
first." Simple questions and read-only work never trigger this, so a quick ask stays quick.

**How it works.** A gate (`isProjectMutation` in `src/agent.ts`) watches for the first
`edit_file`/`write_file` under the project folder; if there's no plan yet, that action is
blocked and the model is told to call the `update_plan` tool. The system prompt also tells it
to *challenge* a request that seems mistaken or unclear instead of blindly executing.

**My take.** This is the right trigger — it keys on "about to change things," not on trying to
guess whether a prompt is "a task," so it separates conversation from real work cleanly. Its
limit: it only forces a plan to *exist*, not to be *good*; a lazy one-line plan passes. The
plan-quality check would ideally come from the critic (see §4), which is currently off.

## 2. Task ledger / decomposition  *(on by default — `ARGO_TASKS`)*

**What it does.** For real work, the model's plan is turned into a **checklist of tasks**. The
harness then drives **one task at a time**: it keeps the whole checklist pinned at the bottom
of the model's context every step (so the goal never scrolls out of view), works the current
task, verifies it, then moves to the next — without needing you to say "continue." If the
model realizes the plan was wrong, it can revise it, and already-finished tasks stay finished.

**How it works.** `update_plan` builds an ordered ledger (`src/tasks.ts`); a later `update_plan`
*reconciles* into the existing ledger (completed items frozen by matching their text). The
ledger is re-printed at the tail of context each turn (`renderTaskLedger`). There is deliberately
**no cap** on how many tasks — big jobs can have long checklists as long as the goal is recited
and loops are watched.

**My take.** This matches the research on keeping small models focused (a running, re-recited
checklist is the single biggest lever). The measured win: on the hardest multi-file test task it
converged in noticeably fewer steps with this on, and no regressions. Weaknesses: matching
"done" tasks by their *text* is brittle — if the model rewords a task, its done-state can be lost
(stable task IDs would be better); and there's no notion of task *dependencies* (the list is linear).

## 3. Not failing / not looping / staying on track  *(mix of always-on + on-by-default)*

Small models get stuck in three different ways, so there are three complementary guards:

- **Loop-recovery ladder** *(on by default — `ARGO_LOOP`)*. Catches the model repeating the
  **exact same action**. It's *mutation-aware*: it only counts a repeat as a loop if **nothing
  changed** since that action last ran — so re-running a test *after* an edit (a legitimate
  re-check) is allowed, but re-running the identical command with nothing changed is blocked on
  the **2nd** try. It escalates: **L0** a firm "stop repeating, here's the goal again" steer →
  **L1** compact the context (a fresh start often unsticks it) → **L2** stop that approach and
  force a revised plan. (`src/loop.ts`.)
- **No-progress re-anchor** *(always on)*. Catches *drift* — many tool calls (with *different*
  arguments each time) but no actual change to the project, i.e. endless re-reading instead of
  acting. After ~12 such calls it restates the goal and demands one concrete change.
- **Stall re-ground** *(always on)*. At fixed points on a long run (iterations 20/35/45) it
  injects a "here's what's done vs. remaining — make the next real change or re-plan" nudge.

**My take.** The breadth is good — they cover identical-loops, novel-argument drift, and slow
non-convergence, which are genuinely different failure modes. The loop ladder is thoroughly
unit- and integration-tested and is safe (it never falsely blocks a real re-check), **but it
hasn't yet had to fire in a real stuck run**, so its *rescue* value is proven in the lab, not
the field. The fixed 20/35/45 thresholds are educated guesses. Hard-won lesson from earlier
experiments: **more iterations is not better** — at very high iteration caps the model thrashed
and once even tried to fake a passing test. The steers all say "keep going"; the real defense
against "doing the wrong thing confidently" is verification (§4), not more nudging.

## 4. Validating what it did  *(the verification stack — see the dedicated section below)*

This is the most important area, so it has its own section at the end ("Task verification — all
the systems"). In short: the harness no longer just *asks* the model whether it's done — for
tasks that can be checked programmatically it **runs a real command** and only advances if it
passes; it then has the model **explain** what it did; and at the very end it **reconciles** all
those explanations against the original goal. Plus a fact-checker for writing tasks.

## 5. Showing progress to the user  *(always on)*

**What it does.** As the agent works, you see a live "trace": each **Iteration N** is a bold
separator, and under it the thoughts, commands, and results. Collapsed, the trace shows the
**current iteration number** as its title and a one-line "what it's doing right now" subtitle,
so you can tell at a glance whether it's on track without reading the firehose. Each surfaced
status line stays up for at least ~5 seconds so fast runs don't flicker past. A small **donut**
in the toolbar shows how full the context is and glows/pulses to signal ready (green), running
(yellow), or compacting (violet). New messages don't yank your scroll if you've scrolled up; a
"jump to latest" button appears instead.

**My take.** This is in good shape. The collapsed "current activity" line is the useful part —
it answers "is it doing something sensible?" without demanding attention. The main thing I'd add
is surfacing the **task checklist progress** ("3 of 7 tasks done, current: X") prominently, since
that's the best at-a-glance health signal and today it's shown to the model but not the user.

## 6. Concluding message  *(on by default, via the final reconciliation)*

**What it does.** When everything is done, the model writes a summary of what it accomplished and
suggests a sensible next step. Crucially, this summary is now **built from the real record** of
what happened per task (see §"Task verification"), not from the model's fuzzy memory after the
context has been compacted.

**How it works.** When the last task completes, a **final reconciliation** step feeds the original
goal plus every per-task summary back to the model and asks it to (a) confirm nothing is missing —
it can re-open work if it is — and (b) only then write the user-facing summary.

**My take.** This directly fixes the old weakness where the conclusion was a vague prompt asking
the model to summarize from lossy memory. It's now grounded in captured records and can catch a
gap before declaring victory. The caveat is the same as any self-review: a model grading its own
summaries can rubber-stamp, which is why the reconciliation is framed to *hunt for what's missing*
rather than ask "are you done?".

## 7. Context management  *(always on)*

The context window is the model's short-term memory; managing it well is what lets a small model
run long without falling apart.

- **Compact near-full, not early.** The harness only compresses the history when it's about to run
  out of room (roughly 4,000 tokens of headroom left), so the model keeps as much real detail as
  possible for as long as possible. (Earlier it compacted at two-thirds full, which threw away
  useful context too soon.)
- **Structured compaction, not a lossy blurb.** When it does compact, it doesn't just summarize —
  it distills a structured ledger: verified facts, decisions made, the user's exact requirements
  and prohibitions ("do not modify X"), changes made, open questions, failed attempts. It then
  checks that summary against the original before trusting it. (`src/compaction.ts`.)
- **Collapse old tool output.** Only the most recent handful of command/file results are kept
  in full in what's *sent* to the model; older large ones are shrunk to a short restorable stub.
  This keeps the live window small (which is what keeps a small model reliably emitting tool
  calls) while the full history is still saved on disk.
- **Recite the goal every step.** The plan/checklist is re-appended at the very end of context
  each turn so the objective stays in the model's most recent attention.

**My take.** This is the strongest part of the harness and matches the research (recite at the
tail; structured compaction beats naive summaries; keep the live window small). The remaining
rough edge: compaction is the slowest single operation and runs on the big model — routing it to
a smaller/faster model is an identified, untested improvement.

## 8. AGENTS.md / MEMORY.md  *(on by default — `ARGO_MEMORY`)*

**What it does.** Two project files give the agent durable knowledge without you having to paste
it every time:
- **AGENTS.md** = standing project instructions. It's **always considered** without you mentioning
  it. If it's short, the whole file is included; if it's long, only the **sections relevant to the
  current task** are pulled in (re-picked per task), so the model isn't buried in irrelevant rules.
- **MEMORY.md** = durable facts worth keeping but not needed every moment. Relevant entries are
  **retrieved for the current task** and shown at the tail; a short "the full files are on disk,
  read them if useful" pointer is always present. When the context compacts, the durable facts it
  distilled are **written into MEMORY.md** so they survive into future runs.

**How it works.** `src/memory.ts` selects AGENTS.md sections and MEMORY.md entries by lexical
relevance to the current objective + task; `src/compaction.ts` persists distilled facts to
MEMORY.md.

**My take.** The design is right (always consider instructions, narrow them per task, keep durable
facts retrievable). Two limits: (1) selection is by **word overlap**, so it can miss a section that's
relevant but worded differently — a semantic/embedding re-rank would help; (2) persisting facts to
MEMORY.md at compaction helps the *next* run but, by deliberate choice, does **not** drop them from
the current live window (safer — the model won't lose something mid-run — but it means compaction
reduces context less than it theoretically could).

---

## Task verification — all the systems

This deserves its own section because "did it actually do the task, or just say it did?" is where
long/complex work fails. There are several layers, and the key distinction is **asserting** done
(the model's word) vs **proving** done (a real check).

Everything hangs off one signal: the model "finishes" a step by replying with **no tool call**
(prose instead of an action). Every layer below is about *not blindly trusting that*.

### A. Executable per-task verification — the real oracle  *(on by default, tasks mode)*
A task can carry a **`verify` command** — a shell command that exits 0 exactly when the task is
truly done (a test, a build, a `grep`, `node --check …`). The model supplies it when it plans
(the `update_plan` tool invites it to). Then, when the model signals that task is done, the
harness **runs the command itself** and:
- **exit 0 → advance** to the next task;
- **non-zero → do not advance** — it feeds the command's actual output back and the model keeps
  working on that task;
- a counter caps consecutive failures (at 3) so a permanently-broken verify escalates to a
  re-plan instead of wedging the run forever.

This is the one layer that **proves** rather than asks. *My take:* it's the biggest quality lever
for long tasks — it's what stops "changed the wrong thing but claimed success." Its power depends
on the model supplying a *good* verify command; the plan tool nudges it to prefer a real check,
but a lazy or wrong command weakens it. Measuring how often the model produces useful verify
commands is the top open validation item.

### B. Per-task summary — "explain how you solved it"  *(on by default, tasks mode)*
After a task passes its verify (or if it has none), the harness asks the model to **summarize in
a few sentences what it did and how**, and records that on the task. This is *softer* than the
oracle — a confident-but-wrong model can still write a plausible summary — but it has two real
benefits: being forced to *explain how* often makes the model notice "wait, I didn't actually do
X" and go back; and it produces a durable per-task record for the final conclusion. It is
**additive** to the oracle (oracle first, explanation second), never a replacement for it.

### C. Final reconciliation — checking the whole against the goal  *(on by default, tasks mode)*
When all tasks are done, the harness feeds the **original objective + every per-task summary**
back and asks the model to find anything missing or inconsistent. If it finds a gap, it re-opens
work (adds/adjusts tasks and keeps going); if not, it writes the grounded final summary (§6).
*My take:* this turns the conclusion into a real verification checkpoint rather than a rubber
stamp — provided it's framed to hunt for gaps, which it is.

### D. Self-check nudge — the fallback  *(on by default, tasks mode)*
For a task with **no** verify command, when the model signals done the harness first asks it to
confirm it's genuinely complete and state how it checked, before advancing. This is the
weakest form (pure self-assertion) and exists only as the fallback when there's no executable
check available. (In the current design the "summarize how you solved it" ask in B doubles as
this confirmation.)

### E. Grounding fact-check — for writing/research tasks  *(on by default — `ARGO_GROUNDING`)*
Separate from code tasks: before finishing a task that produced a **document**, the harness
re-reads the sources the model actually fetched and checks the document's facts and numbers
against them, blocking completion until unsupported claims are fixed or generalized. *My take:*
this is a real gate (it re-injects source text and blocks); measured to eliminate severe factual
errors, though it can miss plausible-sounding conflations. Applies to factual documents, not code.

### F. Whole-run conclusion gate  *(always on)*
Independently of tasks mode, when the model tries to end the entire run it's told to verify the
objective against the original request (run the relevant test/command) before giving its final
answer. Prompt-based, so quality varies — the task-level oracle (A) is the stronger mechanism.

### G. Layout judge — visual verification  *(optional — `ARGO_LAYOUT`, off)*
Built but off pending validation: before finishing a task that produced an HTML page, the harness
renders it, screenshots it, and asks a **local vision model** (`qwen2.5vl`) to flag clear layout
problems (overflow, overlap, truncation), blocking on issues. Fail-open (a render/model error
never blocks a legitimate finish). *My take:* promising for UI/document work but unproven — needs
a live eval before turning on.

### H. Critic — second-opinion review  *(optional — `ARGO_CRITIC`, off)*
A second pass by the model that critiques the plan/work at checkpoints. It's off: its measured
value was inconclusive and it adds latency; the executable oracle (A) is the preferred lever for
the same goal. Available for experiments.

### The verification stack in one line
The model **asserts** it's done (D, F) → the harness **proves** it with a real command where one
exists (A) → the model **explains** how (B) → facts are checked for documents (E) → visuals for
pages (G, optional) → and everything is **reconciled against the goal** at the end (C). The move
from "trust" to "an oracle" (A) plus a grounded conclusion (B+C) is the core of how Argo now tries
to make sure the agent is genuinely done, not just claiming to be.

---

## Current defaults (summary)
On by default: task ledger, memory (AGENTS.md/MEMORY.md), loop-recovery ladder, grounding
fact-check, executable per-task verification + summaries + final reconciliation (all part of
tasks mode). Off by default: critic, layout judge, auto-commit. Always on: the plan/act gate,
no-progress + stall guards, progress trace, context compaction + recitation, whole-run conclusion
gate.

## What's still open
- **Measure the oracle in use:** an eval (n≥3 + a deliberately looping/adversarial case) that hands
  tasks `verify` commands, to see how well the model uses executable verification + reconciliation,
  and to finally exercise the loop ladder's rescue in a real run.
- **Validate the layout judge live**, then decide whether to turn `ARGO_LAYOUT` on for UI/writing tasks.
- **Smaller improvements:** stable task IDs (vs. text matching), semantic memory selection (vs. word
  overlap), routing compaction to a faster model, and surfacing task-checklist progress to the user.
