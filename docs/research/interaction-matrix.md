# Interaction matrix

Which of Argo's mechanisms work well together, which are neutral, which are redundant, and which are
**actively worse when both are on**.

This document exists because Argo has already been damaged once by an unexamined pair. Harness
task-sequencing was left active in Planner frames; it destroyed **9 of 23 Planner frames (39 %)**,
reduced **84 of 85 task graphs to a single step**, and produced a wrong architectural conclusion that
stood across three documents and cost three hypotheses and two eval sessions. **That was not a
complexity cost. It was a correctness bug.** The purpose of this matrix is to find the others before
they fire.

---

## The neutrality test

435 pairs is too many to argue individually, and most are genuinely independent. A pair is **neutral**
unless at least one of these holds:

1. **Shared mutable state** — both read or write the same field (`currentPlan`, `taskList`,
   `editedPaths`, `loopState`, `episodes`, `doneStepIds`, `MEMORY.md`, the ledger).
2. **Shared budget** — both consume the same scarce resource: iterations in a frame, tokens in the
   context window, or the global run budget.
3. **Producer/consumer** — one's output is the other's input, or one's trigger is the other's effect.

Every pair marked non-neutral below fails the test on at least one count, and the row says which. Pairs
not listed are neutral: no shared state, no shared budget, no data flow. A handful of *interesting*
neutrals are listed anyway at the end, because "these two do not interact" is sometimes the answer to a
real question.

## Mechanism index

| ID | Mechanism | State today |
|---|---|---|
| **M1** | Plan/act gate (`agent.ts:1624`) | on, 81 firings, 95 % compliance |
| **M2** | Harness task sequencing — task ledger, advance nudge, summary ask, final reconciliation (`ARGO_TASKS`, `agent.ts:1445`) | on in **every** frame; 76/113/50 firings |
| **M3** | Executable per-task `verify` (`agent.ts:1448`) | on, 109 executions (87 pass / 22 fail) |
| **M4** | Done-gate re-ground (`agent.ts:1578`) | on, 115 firings |
| **M5** | Grounding guard (`agent.ts:1092`) | on, 27 firings, one-shot |
| **M6** | Actor-critic (`critic.ts`) | **OFF**; 8 historical firings |
| **M7** | Tester frame + REDO (`dispatch.ts:379`) | on, 85 frames, **0 REDO ever** |
| **M8** | Boss stand-ups + final checkpoint (`dispatch.ts:719`) | on, 22 stand-ups, 1 actionable verdict |
| **M9** | Planner + task graph + replan (`dispatch.ts`, `tasks.ts`) | on, 23 frames, 84/85 graphs single-step |
| **M10** | Loop ladder L0 — block on exact repeat (`loop.ts:120`) | on, 170 firings, 4 % desired effect |
| **M11** | Loop ladder L1 — compact/evict (`agent.ts:1651`) | on, 26 firings |
| **M12** | Loop ladder L2 — demand a reframe | on, 15 firings |
| **M13** | Near-duplicate guard (`loop.ts:83`) | on, 180 firings, 0/180 effect |
| **M14** | Stall/progress checkpoints + no-progress re-anchor (`agent.ts:1298`, `:1791`) | on, 251 + 30 firings |
| **M15** | Episode eviction (`eviction.ts`, `agent.ts:645`) | on, **3 firings, all via L1** |
| **M16** | Pinned anchor (`eviction.ts:70`) | **UNWIRED — 0 call sites** |
| **M17** | LLM compaction (`agent.ts:1377`) | on, 14 firings |
| **M18** | Durable memory write (`agent.ts:758`) | on, **2 writes, both harmful** |
| **M19** | `MEMORY.md`/`AGENTS.md` injection + retrieval (`agent.ts:830-849`) | on, unreachable in every eval workspace |
| **M20** | Per-frame iteration caps + cap-hit fail-open (`frames.ts:38-43`, `dispatch.ts:191`) | on, **43 blank frames recorded as successes** |
| **M21** | Global iteration budget + budget-aware gate yield | **PROPOSED** — does not exist |
| **M22** | Frame context isolation (own `sessionId`, history, compaction state) | on |
| **M23** | `resumeFrame` (REDO / replan / marker retry) (`dispatch.ts:172`) | on, 3 uses ever; **wipes frame state** |
| **M24** | Role tool restrictions + rejection surfacing (`agent.ts:593`) | on, 102 role rejections, 67 ignored |
| **M25** | Eval integrity + regression gates (`tasks.mjs`) | fixed in Batch 1, demonstrated |
| **M26** | Plan recitation at the tail (`agent.ts:824`) | on, **not logged**, never verified |
| **M27** | Auto-commit (`ARGO_AUTOCOMMIT`) | **OFF** |
| **M28** | Diff-derived `filesWritten` (a per-frame `git status` snapshot) | **PROPOSED** — today derived from tool calls |
| **M29** | Ledger — audit trail + `ledger` tool (`ledger.ts`) | on, 19 task ledgers; `recordStandup` dead |
| **M30** | Multi-turn task sequences in the eval | **PROPOSED** — `tasks.mjs` has no follow-up support |

---

## The grid

`+` synergistic · `.` neutral · `X` conflicting · `=` redundant/overlapping · `?` conditional — depends
on how it is built, or changes verdict once a pending fix lands.

**Marks describe the system as it is today, not as it is designed.** Several `X` marks are conflicts
*because* of a known unfixed defect and become `+` once it is fixed — every pair involving **M20**
(the cap-hit fail-open) is of that kind, and so is **M3 × M7**. The reason column always says which.
65 of the 435 pairs are non-neutral: 27 conflicting, 11 redundant, 17 synergistic, 10 conditional.

```
       1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30
M1        +  +  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  +  .  +  .  .
M2           +  =  .  .  X  X  X  .  .  .  .  .  .  .  .  .  .  X  +  .  .  .  .  .  .  .  .  .
M3              .  .  .  ?  .  .  .  .  .  .  .  .  .  .  .  .  X  .  .  .  .  +  .  .  .  .  .
M4                 =  =  .  .  .  .  .  .  .  =  .  .  .  .  .  X  .  .  .  .  .  .  .  .  .  .
M5                    =  .  .  .  .  .  .  .  .  .  .  .  .  .  X  .  .  .  .  .  .  .  .  .  .
M6                       =  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
M7                          .  .  .  .  X  .  .  .  .  .  .  .  X  .  .  X  .  .  .  .  +  .  .
M8                             X  .  .  X  .  .  .  .  .  .  .  X  .  .  .  X  .  .  .  +  +  .
M9                                X  .  X  X  .  .  .  .  .  .  X  .  .  X  X  .  .  .  .  .  .
M10                                  ?  ?  =  .  X  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
M11                                     .  .  .  X  .  =  .  .  .  .  .  .  .  .  .  .  .  .  .
M12                                        .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
M13                                           .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
M14                                              .  ?  .  .  .  X  ?  .  .  .  .  .  .  .  .  .
M15                                                 +  =  .  ?  .  .  =  .  .  .  .  .  .  .  +
M16                                                    .  .  ?  .  .  .  .  .  .  ?  .  .  .  +
M17                                                       X  .  .  .  =  .  .  .  .  .  .  .  +
M18                                                          X  .  .  .  .  .  .  .  .  .  .  .
M19                                                             .  .  .  .  .  .  .  .  .  .  +
M20                                                                ?  .  X  .  .  .  .  .  .  .
M21                                                                   .  .  .  .  .  .  .  .  .
M22                                                                      .  .  .  .  .  .  +  .
M23                                                                         .  .  .  .  .  .  .
M24                                                                            .  .  .  .  .  .
M25                                                                               .  X  .  .  ?
M26                                                                                  .  .  .  .
M27                                                                                     .  .  .
M28                                                                                        +  .
M29                                                                                           .
```

---

## Conflicting pairs — turning both on is worse than either alone

Ordered by how much damage they have caused or will cause. **This is the most valuable section of this
document.**

| Pair | Test failed | Why it conflicts | Evidence |
|---|---|---|---|
| **M2 × M9** — task sequencing × Planner | producer/consumer, shared budget | `spawnFrame` (`dispatch.ts:141`) never calls `setTasks(false)`, so the Planner runs the Implementer's task ledger. `update_plan` is in `ROLE_TOOLS.planner` (`frames.ts:21`), the tool schema asks for a `verify` command (`tools/index.ts:187`), and the verify gate then intercepts the Planner's **no-tool-call final answer — which is its output contract** — every turn until the cap. | **A.** 9 of 23 Planner frames die at cap (39 %); 8 of 8 large-task frames produced valid 2–5-step graphs and all were discarded; 84 of 85 executed graphs single-step. `EVIDENCE-planner-trap.md` |
| **M7 × M23** — Tester REDO × `resumeFrame` | shared mutable state | Enabling REDO activates a state wipe. `agent.chat()` reinitialises `currentPlan`, `taskList`, `loopState`, `editedPaths`, `episodes`, `finalReconciled` (`agent.ts:1212-1241`) and restarts the iteration counter (`agent.ts:1288`). A resumed Implementer loses its plan, verify state and file list, so `deriveFrameResult` records empty `filesWritten` and `finalReconciled = false` re-arms the reconciliation gate. | **A** (code-verified; the marker-retry resume wrote a new log starting at `ITER 1/10`). Latent: 0 REDOs so far |
| **M8 × M9** — stand-up escalate × replan | shared mutable state | `readyGroups` is computed once per outer iteration (`dispatch.ts:668`). A stand-up returning `escalate` calls `replan()`, which replaces `graph` and clears `doneStepIds` (`dispatch.ts:605`). Control returns to the **stale** `groups` map, spawns frames for the old graph's steps, and writes their ids into the fresh `doneStepIds`. Step ids are positional (`s1..sn`), so old and new collide — **new steps get marked done without running.** The failure-status branch above has an explicit `break` for exactly this; the escalate path does not. | **A** (code-verified). Latent only because `groups.size` has always been 1 |
| **M9 × M23** — replan × `resumeFrame` | shared mutable state | A replan resumes an existing frame, so it inherits the whole M7 × M23 wipe. Replan has run **once** in the corpus. | **A** (code) |
| **M2/M3/M4/M5 × M20** — the end-of-frame gate cluster × per-frame caps | shared budget | Four gates (advance nudge, summary ask, final reconciliation, done-gate re-ground) fire on the way out of a frame, none aware of remaining iterations. **354 forced extra model turns** across the corpus (September: 278). Measured outcome: three consecutive gates in iterations **58/59/60** ended a *correct* run in "no final answer", with the same error signature in logs back to 2026-07-27. | **A.** Ranked #1 by the project itself; confirmed no budget awareness exists anywhere in `agent.ts` |
| **M7 × M20** — Tester × cap-hit fail-open | producer/consumer | `parseTesterVerdict` (`frames.ts:152`) fails open to `release`, and a cap-hit produces the string that no verdict regex matches. **A stalled Tester silently approves the work.** 2 of 85 Tester frames ended at cap. | **A.** 29 of 29 ledger verdicts are RELEASE; "verified" is indistinguishable from "defaulted" |
| **M9 × M20** — Planner × cap-hit fail-open | producer/consumer | `parseTaskGraph` (`dispatch.ts:398`) fails open to a one-step graph. So a capped Planner yields "no decomposition" indistinguishably from "decided not to decompose". This is the mechanism by which M2 × M9's damage stayed invisible for two sessions. | **A** |
| **M8 × M20** — stand-up × cap-hit fail-open | producer/consumer | `parseBossVerdict` fails open to `none` = all clear. 3 of 22 stand-ups were cap-hit blanks and 3 more produced no keyword: **6 of 22 (27 %) gave no usable verdict** and all read as healthy. The Finding-8 fix covers only the capped subset. | **A** |
| **M14 × M20** — stall triggers × caps | shared budget | Stall re-ground fractions scale off the iteration cap (`agent.ts:1275`). Change a cap and these triggers silently move. | **A** (code) |
| **M20 × M23** — caps × resume | shared mutable state | `lastIterationCount` restarts at 1 on resume, so `hitCap`, `justRanLong` (>25 → stand-up) and `hadTrouble()` are **blinded on any resumed frame**. | **A** (code + one observed log) |
| **M18 × M19** — durable memory write × memory injection | shared mutable state, producer/consumer | A self-poisoning loop. The write path rendered tool calls verbatim (`Called bash({…}) Result: …`, `compaction.ts:141` feeding a prompt that says copy verbatim at `compaction.ts:211-215`) into `test-two/MEMORY.md` at lines 101 and 130; that file is **re-injected every iteration** and `selectMemoryEntries` will surface `Result: 2 passed, 3 failed` as relevant memory for any task mentioning tests. Both writes contained counts that were false by the end of the session. | **A.** 2 of 2 writes harmful; H15 |
| **M17 × M18** — compaction × durable memory write | producer/consumer | The write path's only call site is **inside** the compaction branch (`agent.ts:758`). So H24 (lowering `COMPACT_RESERVE_TOKENS` to force long-horizon) multiplies the M18 × M19 poisoning by however much more often compaction fires. **Fix M18 before doing H24.** | **A** (code + 14 compactions, 2 writes) |
| **M12 × M7**, **M12 × M8** — L2 reframe × non-Implementer roles | producer/consumer | L2's fallback wording is "Produce a revised plan now for solving the current task a different way" — nonsensical for a checkpoint whose only job is to emit NONE/INJECT/RESTART/ESCALATE. Observed: a Boss stand-up looping on `ledger get_conclusion` received it **twice**, then hit `ITER 15/15` and stalled blank. A loop guard causing the cap-hit failure it exists to prevent. | **A** (one full trace) |
| **M12 × M9** — L2 × Planner | producer/consumer | Same class; `hasUpdatePlan` (`agent.ts:1322`) was patched to stop telling the *Planner* to call `update_plan`, but the fallback branch still gives every non-Implementer role planning advice. **Partially fixed, not fixed.** | **A** (code) |
| **M9 × M10**, **M9 × M13** — loop guards × legitimate re-reading | shared budget | L0 blocked a Planner's legitimate second read of a file it needed, **twice in one frame**, spending an iteration each time. The near-duplicate nudge fires on a Planner reading files, which is what that role does. A guard that punishes correct behaviour is worse than no guard. | **A.** `ASSESSMENT.md` §4 |
| **M10 × M15** — L0/loop response × eviction | producer/consumer | Argo's `evict()` strips **oldest action episodes first** — which is where the error traces live. Manus's position is that keeping failures in context is what stops the model repeating them. So the loop response deletes the evidence that suppresses the loop. | **A** for the eviction order (`eviction.ts`), **C** for the mechanism ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Dormant: 3 firings |
| **M11 × M15** — L1 × eviction | producer/consumer | **All 3 eviction firings in the corpus came via L1** (`agent.ts:1651`), never via the context threshold. So the loop guard is Argo's de facto context policy. And because `maxLiveChars = 60 000` (~15 k tokens) sits 4× below the 61 440-token trigger, whenever L1 fires eviction stubs ~15 episodes at once — a cliff, not a policy. | **A.** 3 firings, 44 episodes; 1 849 of 5 003 turns above 15 k |
| **M8 × M24** — Boss self-attempt × role restrictions | shared budget | The Boss is responsible for **53 of 102** role-restriction rejections, repeatedly trying `write_file`/`edit_file` at checkpoints where it has only `bash`, burning an iteration each out of a 10–15-iteration budget. **23 of 94 task-starts (24 %) end with the workspace dirty.** The design instructs against self-attempts and then permits them: it pays for both. | **A** |
| **M9 × M24** — Planner × role restrictions | shared budget | 48 role-restriction rejections came from Planner frames trying to implement under verify-gate pressure, nine in a single frame. Downstream of M2 × M9 — fixing that should remove most of these. | **A** |
| **M25 × M27** — eval integrity gate × auto-commit | producer/consumer | The integrity and regression gates diff against a baseline ref. Auto-commit moves HEAD mid-run and breaks the comparison. `ARGO_AUTOCOMMIT` is off; keep it off during evals, unconditionally. | **A** (code reasoning) |

### Conditional conflicts — depend on how they are built

| Pair | Verdict | Reason |
|---|---|---|
| **M16 × M26** — pinned anchor × plan recitation | **Conflicting if built as two tail blocks; synergistic if merged** | Both push content to the end of the prompt. Two separate blocks recite the plan **twice per turn**: a direct token cost against 1 270 tokens of headroom, and exactly the uniform repetitive context Manus identifies as a cause of mimicry and drift. **You would be paying for anti-drift with a drift mechanism.** Merge into the one block `agent.ts:824` already pushes. Evidence **A** (both target the tail) + **D** (Manus). |
| **M20 × M21** — per-frame caps × global budget | **Conflicting unless ordered and jointly computed** | Two failure directions: a frame with plenty of its own budget gets a "wrap up now" injection because the *global* budget is nearly spent (work truncated); or a frame hits its own cap while the global budget is untouched (the global cap never binds). The yield must be driven by `min(frameRemaining, globalRemaining)`, both numbers recorded. **And the ordering is a correctness requirement:** a global cap built before M20's fail-open is fixed will discard an entire run's result exactly as the harness currently discards a Planner's task graph. Evidence **A** (43 frames) + reasoning. |
| **M16 × M19**, **M15 × M19** — pinned content × injected memory | **Conflicting but already bounded** | Both are non-evictable content competing for the last 1 270 tokens (peak 64 266 of 65 536). Gabriel asked whether durable memory becomes the leak eviction was meant to close: **measured answer, no — not by volume.** `PROJECT_CONTEXT_CHAR_CAP = 8000` (~2 k tokens) already closes it, and tail retrieval is task-scoped. The real conflict is **quality** (M18 × M19), not size. Do not raise the cap without re-measuring peak context. Evidence **A** |
| **M14 × M21** — stall checkpoints × budget-aware yield | **Conflicting if the yield does not suppress them** | Stall and progress checks each cost a turn, and they can fire in the same last iterations as the gates. The yield must suppress *all* turn-consuming interventions near the boundary, not only the four gates. Evidence **A** (251 firings) + reasoning |
| **M25 × M30** — eval reproducibility × multi-turn tasks | **Conditional** | `resetWs` between tasks is what makes the suite reproducible. Skipping it *inside* a turn sequence is correct and necessary; skipping it *between* sequences destroys reproducibility. Make the boundary explicit in the driver. Evidence **A** (`e2e.mjs`) |

---

## Redundant / overlapping pairs

| Pair | Verdict | Reason | Evidence |
|---|---|---|---|
| **M4 × M5 × M6 × M2(reconcile)** — the done-gate cluster | **Redundant; keep one prompted + one machine check** | Four mechanisms fire on the same event ("the model says it is done"): final reconciliation (50), done-gate re-ground (115), grounding guard (27), pre-done critic (4). Keep the re-ground (best measured conversion, 38 %) plus the machine checks (`verify` + regression gate). | **A** |
| **M4 × M14** | **Partially redundant** | A PROGRESS CHECK asks the model to state which steps are done; the done-gate re-ground asks it to re-justify done-ness. Same request, different trigger. | **A** (199 + 115 firings) |
| **M6 × M7** — actor-critic × Tester frame | **Redundant; keep the Tester** | The Tester does the critic's job **with real tools**, which is the configuration the literature supports — intrinsic self-correction without external feedback does not work ([arXiv 2310.01798](https://arxiv.org/abs/2310.01798)). `ARGO_CRITIC` is off; leave it off. 209 + 119 lines of carried weight. | **A** (8 firings, inconclusive) + **B** |
| **M10 × M13** — L0 × near-duplicate guard | **Redundant; delete M13** | The near-duplicate nudge is a strictly weaker L0 on the same signal. **180 firings — the most-fired mechanism in the harness — and in 180 of 180 cases the next tool call is another call to the same tool.** It never blocks, so its only cost is context, but its stated goal has a 100 % null result. | **A.** H19 |
| **M10 × M11**, **M10 × M12** | **Redundant *after* the L0 fix** | The L0 escalation ladder exists because a block gets evaded. If L0 stops blocking and instead serves the cached prior result (`05` §4), there is nothing to escalate — and L1 and L2 may become unnecessary. Removing L1 would also remove the accidental M11 × M15 coupling. Test before deleting. | **A** (6 of 143 desired effect; 46 of 57 same-target follow-ups evade) |
| **M15 × M17** — eviction × compaction | **Overlapping** | Two context-reduction mechanisms on nearly the same trigger; eviction has only ever run *because* of L1, never the threshold it shares with compaction. Decide which owns the threshold. | **A** (3 vs 14 firings) |
| **M11 × M17** — L1 × compaction | **Overlapping by construction** | L1's action *is* compact-or-evict. Same mechanism reached by a different trigger. | **A** |
| **M17 × M22**, **M15 × M22** — compaction/eviction × frame isolation | **Partially redundant — measured** | Gabriel's question: does isolating context remove the need to compact? **Partly, and there is a number.** Of 14 compactions in the corpus, **12 are in `test-two`** (the baseline single-loop workspace) and `bigproj`, where multi-agent runs, has **one**. Isolation demonstrably reduces compaction pressure. It does **not** remove it: peak context reached 64 266, and `doneSummary` concatenates every step's summary (`dispatch.ts:756`). So: keep compaction, deprioritise it relative to isolation. | **A** |
| **M3 × M7** — executable verify × Tester frame | **Complementary in design; redundant in practice today** | Gabriel's question. In design they differ: `verify` is a per-step oracle **the model wrote**, the Tester is an independent check of the **claim**. In practice the verify gate does all the work (109 executions, 22 real failures caught) and the Tester has **never rejected anything in 85 frames**. So today the Tester is decoration. It stops being decoration only if it gets a real diff (M28) and a non-fail-open verdict (M20 fix). Until then, the pair is redundant with the wrong half doing the work. | **A** |
| **M14 × M16** — no-progress re-anchor × pinned anchor | **Conditionally redundant** | The re-anchor (30 firings, 33 % conversion) re-surfaces the goal when nothing has been mutated for 12 tool calls. If the pinned anchor is present on **every** turn, the re-anchor adds urgency, not information. Testable prediction: **if H23 works, the re-anchor's firing count should fall.** If it does not, the anchor is not doing what it claims. | **A** + reasoning |

---

## Synergistic pairs

| Pair | Why | Evidence |
|---|---|---|
| **M1 × M26** — plan gate × recitation | The gate forces a plan to *exist*; recitation keeps it in attention. **77 of 81 gate firings are followed by a `plan` event within six events (95 %)** — the cleanest cause-and-effect in the harness. This is the pair with the best local evidence, and the literature agrees (mode-as-state plus `todo.md` recitation). | **A** + **D** |
| **M15 × M16** — eviction × pinned anchor | Each is weaker alone and the combination is the design. Eviction without an anchor trims context with no protected objective — **the exact configuration the anchor exists to prevent, and the one Argo is in today** (3 firings, 0 anchor). An anchor without eviction is harmless but unexercised. | **A** (code + firing counts) + **B/WEAK** ([StreamingLLM](https://arxiv.org/abs/2309.17453) as mechanism analogy only) |
| **M20-fix × M7 / M9 / M8 / M21** — cap-hit → `partial` | A prerequisite, not a peer. Every one of those four inherits the fail-open until `deriveFrameResult` distinguishes a capped frame. **43 frames** currently prove it. Fixing M20 also makes the dispatch loop's `status === 'failed' \|\| 'killed'` replan branch reachable for the first time — which means it has never been tested. | **A** |
| **M28 × M1 / M7 / M8 / M29** — a per-frame `git` snapshot | One model-independent signal improves four mechanisms: it closes the plan gate's `bash` hole (`isProjectMutation` inspects only two tool names), gives the Tester a real diff instead of *"none (or made via bash, not tracked)"* (`dispatch.ts:389`), gives the Boss an artifact instead of a self-report, and makes `filesWritten` what `types.ts:135` already claims it is (**empty in 4 of 9** Implementer conclusions today). External support: monitoring the trace beats monitoring outputs, and a weaker monitor on a trace beats a strong monitor on a report ([arXiv 2503.11926](https://arxiv.org/abs/2503.11926)). **The highest value-per-line pair in this document.** | **A** + **B** |
| **M1 × M3** — plan gate × executable verify | The gate is what forces `update_plan`, and `update_plan` is where the `verify` command is registered. That makes registration the natural place to **validate** the verify command by running it once — which removes the largest observed verify failure class (4 of 22 firings are thrash on structurally impossible commands). | **A** |
| **M1 × M2** — plan gate × task ledger | In Implementer frames these compose correctly: the gate forces a plan, the ledger sequences it, the verify gate closes each step. **M2's harm is entirely about the roles it should not be applied to**, not about the mechanism. Same flag, opposite value. | **A** |
| **M2 × M21** — gate chain × budget-aware yield | The yield is what makes the gate chain safe. 354 round-trips become 354 round-trips *that never land in a frame's last three iterations*. | **A** |
| **M3 × M25** — model-supplied verify × integrity + regression gates | The model partly writes its own oracle, which is the SWE-Bench+ weak-test problem with the adversary inside the loop (**31.08 % of passing patches suspicious due to weak tests**; resolution 12.47 % → 3.97 % after filtering). The byte-comparison integrity gate and the baseline-regression gate are the model-independent counterweights. Keep both as **gates**, never as points. | **A** + **B** ([arXiv 2410.06992](https://arxiv.org/abs/2410.06992)) |
| **M8 × M29** — stand-ups × ledger | Stand-ups become cheap only if prior stand-ups are readable. Today `ledger.recordStandup` (`ledger.ts:145`) has **zero call sites**, so **16 of 22 healthy stand-ups left no trace**, and the observed stand-up made **8 tool calls** re-investigating from scratch. One call site converts stand-ups from re-investigation into reading. | **A** |
| **M22 × M29** — frame isolation × ledger | Isolation is only survivable because the ledger carries state across frame boundaries. Every deep finding in the last two sessions was reconstructible only because the ledger exists. | **A** |
| **M28 × M29** | Makes the ledger's documented claim ("diff-derived, not self-reported") true. | **A** |
| **M30 × M19** — multi-turn tasks × memory | The **only** way to test cross-turn memory. Today every task is a single prompt and `resetWs` wipes the workspace between tasks, so the read path has never been exercised in any eval. Primary metric already specified: tool calls before the first edit on turn N. | **A** |
| **M30 × M15 / M17 / M16** — multi-turn tasks × the long-horizon machinery | Multi-turn is the cheapest route to a genuinely long context, and long context is where eviction, compaction and the anchor all become real. `tasklab` at 827 LOC cannot fill a 65 k window on one prompt. | **A** |

---

## Interesting neutrals — stated because "no interaction" answers a real question

| Pair | Verdict | Why |
|---|---|---|
| **M5 × M7** — grounding checks × Tester frame | **Neutral, by disjoint reachability** | Gabriel asked whether these are two verification passes or one wasted. Neither: `DOC_EXTS` (`grounding.ts:47`) limits the grounding guard to `.html/.md/.txt/.rst`-class edits, so it **can never fire on a coding task** — and every eval workspace is all-code. Doc-path edits in the corpus: `bille.html` 39, `index.html` 25, `ANALYSIS.md` 10, `fact.txt` 1, all in `booklet` and `test-two`. They operate on disjoint task classes and do not compete. Corollary: `ARGO_GROUNDING` being ON by default contributes **nothing** to the eval suite as it stands. |
| **M22 × M19** | **Neutral** | Each frame injects memory into its own window, so the cost is per-frame and not additive within one context. |
| **M25 × M28** | **Neutral** | Both use `git`, for unrelated purposes (baseline comparison vs frame file lists). |
| **M6 × M25** | **Neutral now, was expected to be synergistic** | The critic's `gamed_oracle` verdict was the agent-side tamper detector to the eval's `testFileTampered`. **Both had zero firings**: `gamed_oracle` 0 of 35 July critic events, and `testFileTampered` structurally could not fire. Two independent tamper detectors, no detections between them, for different reasons. |

---

## The three findings to act on first

1. **M2 × M9 (task sequencing × Planner)** — already measured, already cost a wrong architectural
   conclusion. The fix is 1–3 subtractive lines and it is the highest-value change available anywhere in
   the codebase. **H17.**
2. **M7 × M23 and M8 × M9 (REDO × resume, replan × stale `readyGroups`)** — two latent correctness bugs
   that arm *exactly when* the two headline Batch-2 changes land. The pattern is "fixing X activates
   bug Y", which is the hardest kind to catch after the fact because the symptom appears in the new
   feature. **Fix both in the same commits as H17 and the Tester fix, not after. H14.**
3. **M18 × M19 (durable memory write × memory injection)** — a self-poisoning loop where the write path
   degrades a read path that runs every iteration, permanently, per workspace. And **M17 × M18** means
   H24 multiplies it. **Fix M18 before H24. H15.**

## How to keep this document true

- When a mechanism is added, run the three-part neutrality test against every existing mechanism and
  record the result here. It takes minutes and it is the cheapest defence available against the class of
  bug this document documents.
- When a mechanism is **deleted**, delete its row and column. A matrix that grows monotonically is a
  matrix nobody reads.
- The `?` rows are the ones to re-check after each batch: their verdict changes when a pending fix lands.
- Cross-references: `01` (context), `02` (decomposition), `03` (supervision), `04` (memory), `05` (loops),
  `06` (budgets), `07` (eval), `08` (communication).
