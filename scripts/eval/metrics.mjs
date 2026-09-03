/**
 * Per-run COST and FRICTION metrics scraped from a run's JSONL logs (BATCH 1,
 * EVAL-PLAN §1.5 / §3.1 / §5.5).
 *
 * WHY THIS FILE EXISTS. e2e.mjs used to scrape three intervention counters inline with
 * three loose regexes over `warning` messages. Two of the three were silently dead:
 *
 *   gate   — the plan/act-gate message moved from a `warning` event to
 *            `tool_result.error` at commit e045d0a ("unified tool-rejection
 *            surfacing"). It fired 49 times in July and 24 times in September; every
 *            recorded eval row says g=0.
 *   steer  — its regex (/no new information|STOP —/) matches only the pre-ARGO_LOOP
 *            wording of loopSteerMessage, which has been dead code since ARGO_LOOP
 *            went on (2026-08-04). Meanwhile the loop ladder fired 158 L0 / 24 L1 /
 *            13 L2 in September; every recorded row says s=0.
 *
 * So `g=0, s=0` in history.jsonl are artifacts, not findings, and any conclusion resting
 * on them should be withdrawn.
 *
 * THE FIX, and the rule this file follows. EVAL-PLAN §5.5 asks for structured
 * `{type:'intervention', mechanism:...}` events. That requires editing src/ (types.ts +
 * ~15 call sites in agent.ts), which is out of scope for this batch, so the counting is
 * still text-based — but not loosely:
 *
 *  1. Every pattern is anchored (`^`) to the LITERAL message-construction site in src/,
 *     cited by file:line in the table below. A pattern is a claim about one line of
 *     src/, not a guess about phrasing.
 *  2. `selfCheckCounters()` asserts each pattern against a KNOWN SAMPLE built from that
 *     same wording, and asserts that the sample matches its own mechanism FIRST and no
 *     other. A wording change in src/ that this file has not tracked shows up as a
 *     self-check failure at eval start, not as a zero six weeks later.
 *  3. Anything that does not match is counted in `warnUnmatched` and up to five distinct
 *     60-char prefixes are recorded on the run row. A counter that stops matching real
 *     traffic therefore becomes visible in the data itself, not just in the self-check.
 *
 * Mechanisms surfaced through `tool_result` are counted off the STRUCTURED
 * `rejected: true` field (types.ts:26) and only sub-classified by text — so the total
 * rejected-call count cannot silently go to zero even if every message is reworded.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ── Intervention catalogue ──────────────────────────────────────────────────────────
// key      counter name on the returned object
// where    which event carries it
// re       anchored pattern
// src      the exact construction site the pattern is anchored to
// sample   a literal instance, used by selfCheckCounters()
export const WARNING_INTERVENTIONS = [
  { key: 'criticRevise', re: /^CRITIC \(/, src: 'agent.ts:1077 (steer)',
    sample: 'CRITIC (pre-done) — revise before continuing.\nIssues: x' },
  { key: 'groundingRevise', re: /^GROUNDING CHECK \(pre-done\) — fix before finishing/, src: 'agent.ts:1158 (steer)',
    sample: 'GROUNDING CHECK (pre-done) — fix before finishing, then stop.\nIssues: y' },
  { key: 'layoutRevise', re: /^Before finishing: the rendered layout of /, src: 'agent.ts:1192 (steer)',
    sample: 'Before finishing: the rendered layout of out.html has problems: overlap. Fix them, then finish.' },
  { key: 'stall', re: /^STALL: \d+ iterations without finishing/, src: 'agent.ts:1327-1329 (stall, isLastCheckpoint)',
    sample: 'STALL: 40 iterations without finishing — your approach is not converging. Conclude NOW with your best verdict/answer given what you have found so far, or take one genuinely different action — do not repeat what has not worked.' },
  { key: 'progressCheck', re: /^PROGRESS CHECK: \d+ iterations in and not finished/, src: 'agent.ts:1331-1332 (stall, non-last checkpoint)',
    sample: 'PROGRESS CHECK: 20 iterations in and not finished. Objective: "x". State what you have confirmed so far, then either conclude with your verdict/answer or take the single most important remaining action — do not keep re-checking the same thing.' },
  // Anchored on the lead only, NOT on the "…FAILED" clause: real task titles run to
  // several hundred characters (they are prompt fragments), so any bounded gap to the
  // word FAILED silently drops the long ones — measured, it lost 8 of 24 September
  // firings. `Verification for ` is unique to the two verify-FAILURE steers; the pass
  // steer starts `VERIFY PASSED`.
  { key: 'verifyFail', re: /^Verification for /, src: 'agent.ts:1460-1464 (steer, both the first-failure and the escalated N-in-a-row variant)',
    sample: 'Verification for the current task "Implement addTask" FAILED — command `npm test` did not pass:\noutput\nFix this before finishing the task.' },
  { key: 'verifyPass', re: /^VERIFY PASSED for task "/, src: 'agent.ts:1475',
    sample: 'VERIFY PASSED for task "Implement addTask" (`npm test`) — capturing a summary before advancing.' },
  // Same reasoning as verifyFail: the title between `CURRENT TASK "` and the rest of the
  // sentence is unbounded, so the lead alone is the reliable anchor (it is unique).
  { key: 'summaryAsk', re: /^CURRENT TASK "/, src: 'agent.ts:1481 (ask)',
    sample: 'CURRENT TASK "Implement addTask" — if it is genuinely complete, reply with a brief 2-4 sentence summary of WHAT you did and HOW you solved it (this becomes the record used for the final check). If it is NOT actually done, keep working on THIS task only.' },
  // `(?: \(verified\))?` covers a HISTORICAL wording: 3 of the 10 July firings read
  // "Task complete (verified). NEXT TASK …". The current src/ emits only the short form,
  // but a counter that silently drops an older shape is the exact defect this file exists
  // to prevent — and the same tolerance means a re-scrape of the July logs classifies
  // cleanly instead of dumping 3 events into warnUnmatched.
  { key: 'taskAdvance', re: /^Task complete(?: \(verified\))?\. NEXT TASK "/, src: 'agent.ts:1504 (adv); pre-2026-08 variant added "(verified)"',
    sample: 'Task complete. NEXT TASK "Wire the query layer". Work only on this task now; the full plan is in the recited ledger. Refine via update_plan only if the work contradicts it.' },
  { key: 'reconcile', re: /^ALL PLANNED TASKS ARE DONE — final check before finishing/, src: 'agent.ts:1530 (reconcileMsg)',
    sample: 'ALL PLANNED TASKS ARE DONE — final check before finishing. Objective: "x". What was done per task:\n- a\nVerify this FULLY addresses the objective.' },
  { key: 'reground', re: /^Before finishing, re-ground against your plan\./, src: 'agent.ts:1580 (nudge)',
    sample: 'Before finishing, re-ground against your plan. Objective: "x". Think critically: is the objective TRULY met — not just that a command exited 0, with no corner cut and the real request satisfied?' },
  { key: 'loopL0', re: /^You just issued the EXACT same `[^`]+` call that already ran/, src: 'loop.ts:148 l0SteerMessage',
    sample: 'You just issued the EXACT same `bash` call that already ran, with nothing changed since. STOP repeating it — take a DIFFERENT concrete action toward the current task, or, if it is truly already done, say so.\n\nrecite' },
  { key: 'loopL1', re: /^Your context was just compacted to help you refocus\./, src: 'loop.ts:158 l1SteerMessage',
    sample: 'Your context was just compacted to help you refocus. You have repeated the same `bash` call several times with no progress. You must change your approach now — do not repeat this call again.\n\nrecite' },
  { key: 'loopL2', re: /^You have repeatedly looped on `[^`]+` without any progress\. ABANDON this approach\./, src: 'loop.ts:167 l2ReframeMessage',
    sample: 'You have repeatedly looped on `bash` without any progress. ABANDON this approach. Produce a revised plan now for solving the current task a different way.\n\nrecite' },
  { key: 'nearDup', re: /^You have now called `[^`]+` \d+ times in a row \(different arguments each time/, src: 'loop.ts:89 checkSameToolStreak',
    sample: 'You have now called `bash` 3 times in a row (different arguments each time, but the same kind of action, with nothing changed in between). If you already have what you need, commit to your verdict or answer now — otherwise take a genuinely different kind of action.' },
  // Both of the next two are regroundSteer(); they differ only in the `detail` clause,
  // which is why each pattern pins that clause rather than the shared lead sentence.
  { key: 'noProgress', re: /^You appear stuck — \d+ tool calls without changing any file\./, src: 'agent.ts:1793 regroundSteer(no-progress re-anchor)',
    sample: 'You appear stuck — 12 tool calls without changing any file. Re-anchor to the objective: "x". Do ONE thing now: either make the single most important change (an edit) that advances that objective, or — if it is already met, or you are genuinely blocked — give your final answer.' },
  { key: 'legacySteer', re: /^(?:You appear stuck — you have repeated the same `|STOP — you keep calling `|That `[^`]+` call used identical arguments and returned the same result as before)/, src: 'agent.ts:222-232 loopSteerMessage (dead while ARGO_LOOP is on)',
    sample: 'That `bash` call used identical arguments and returned the same result as before — no new information. If you were checking whether a change took effect, verify it where it actually applies.' },
  // Pre-e045d0a plan-gate wording, surfaced as a `warning` rather than a rejected
  // tool_result. Absent from the current src/ (verified: no such string in src/agent.ts),
  // but present 8 times in the September log window, so it is classified rather than
  // dumped into warnUnmatched — and it stays a tripwire if that surfacing is ever
  // reverted. This is the exact string the old, now-dead `gate` counter matched.
  { key: 'legacyPlanGate', re: /^Before changing the project \(`/, src: 'pre-e045d0a agent.ts (removed); still present in 2026-07..09 logs',
    sample: 'Before changing the project (`edit_file` on /workspace/src/kth.js) you must record a plan first.' },
  // Plumbing/failure warnings — real events, but not interventions. Bucketed so they do
  // not inflate warnUnmatched and hide a genuine wording drift.
  { key: 'infraWarn', re: /^(?:Marking episode evicted failed|MEMORY\.md persist failed|Ollama request failed|Critic \([^)]*\) (?:failed|returned no parseable verdict)|Grounding guard (?:failed|returned no parseable verdict)|Context compaction failed|Loop-recovery compaction failed|Episode record failed|Auto-commit)/, src: 'agent.ts 656/764/885/1054/1058/1129/1133/1394/1656/1743/1947/1967',
    sample: 'Ollama request failed (socket hang up) — retrying once' },
];

// Mechanisms surfaced as a REJECTED tool call (tool_result.rejected === true) rather
// than a warning. This is the class e045d0a moved and the old `gate` counter lost.
export const REJECTION_INTERVENTIONS = [
  { key: 'planGate', re: /^REJECTED — this \S+ call was NOT applied, nothing changed on disk\./, src: 'agent.ts:1631 (gate)',
    sample: 'REJECTED — this write_file call was NOT applied, nothing changed on disk. You must record a plan first.' },
  // Greedy `[\s\S]*` between the quote and the fixed tail, not `[^"]+`: a stalled model
  // sometimes emits PROSE as the tool name ("TRIVIAL: fixed the off-by-one…", "ANSWER: …"),
  // which contains its own quotes and newlines. Measured on the September logs, the
  // narrow form matched 98 of 102 real role rejections; this form matches all 102.
  { key: 'roleReject', re: /^tool "[\s\S]*is not available in this role — it was NOT called\.$/, src: 'agent.ts:1620',
    sample: 'tool "write_file" is not available in this role — it was NOT called.' },
  { key: 'loopSkip', re: /^SKIPPED — identical to a call already run with nothing new since\./, src: 'agent.ts:1660 / 1690',
    sample: 'SKIPPED — identical to a call already run with nothing new since. You just issued the EXACT same `bash` call that already ran' },
];

// ── Interventions carried by STRUCTURED FIELDS, not by prose ────────────────────────
// Found by censusing every event type across the July (89 files) and September (478
// files) logs rather than by reading src/ alone. These need no regex at all, so they
// cannot rot the way the `gate` and `steer` counters did — they are the shape the prose
// counters above should eventually all be replaced by (EVAL-PLAN §5.5).
//
//   tasks.action              'planned' | 'replanned' | 'advanced'   (types.ts:66-76)
//   boss_verdict.action       'inject' | 'restart' | 'escalate'      (types.ts:90)
//   replan                    dispatch-level forced re-plan          (types.ts:91)
//   critic.verdict / .gamed_oracle                                   (types.ts:~58)
//   task_graph.steps.length   decomposition width                    (types.ts:83-88)
//
// Measured September totals, none of which anything has ever counted: 105 ledger
// advances, 91 ledger REPLANS, 78 ledger builds, 1 boss escalate (0 inject, 0 restart),
// 1 dispatch replan, and 84 of 85 task graphs with exactly ONE step.
//
// Note `tasksAdvanced` (105) is deliberately NOT the same number as the `taskAdvance`
// prose counter (69): the ledger emits `advanced` on every advance, but the nudge warning
// only fires when a NEXT task exists, so the 36 final advances cost no round-trip.
// gateRoundTrips uses the 69 — the count of forced turns — which is what keeps it equal
// to EVAL-PLAN §1.5's 278.

// Frame budget exhaustion. agent.ts:1801 emits this as an `error`, and it is the string
// that makes parseTesterVerdict/parseTaskGraph fail open (ASSESSMENT §5.2a) — so its
// count is the single most load-bearing friction number in the whole vector. Confirmed:
// 44 of 44 September `error` events are this, and one September `replan.reason` quotes it
// verbatim as the cause of a Boss standup escalation.
export const CAP_HIT_RE = /^Reached maximum iterations \(\d+\) without a final answer\.$/;
// eviction and LLM compaction share the `compact` event; only the summary distinguishes
// them (agent.ts:663).
export const EVICTION_RE = /^deterministic eviction:/;

/**
 * Assert every pattern against its own known sample, and assert first-match uniqueness.
 * Returns { ok, failures: string[] }. Callers should print failures LOUDLY and record
 * the verdict on every row — a counter that stops matching must never be a silent zero.
 */
export function selfCheckCounters() {
  const failures = [];
  const check = (list, label) => {
    for (const spec of list) {
      if (!spec.re.test(spec.sample)) failures.push(`${label}.${spec.key}: pattern does not match its own sample (src ${spec.src})`);
      const firstHit = list.find(s => s.re.test(spec.sample));
      if (firstHit && firstHit.key !== spec.key) failures.push(`${label}.${spec.key}: sample is claimed first by ${label}.${firstHit.key} — reorder or tighten`);
    }
  };
  check(WARNING_INTERVENTIONS, 'warning');
  check(REJECTION_INTERVENTIONS, 'rejection');
  if (!CAP_HIT_RE.test('Reached maximum iterations (60) without a final answer.')) failures.push('capHit: pattern does not match its own sample (agent.ts:1801)');
  if (!EVICTION_RE.test('deterministic eviction: stubbed 3 episode(s) (recoverable via ledger expand)')) failures.push('eviction: pattern does not match its own sample (agent.ts:663)');
  return { ok: failures.length === 0, failures };
}

const FRAME_SESSION_ID = /^(planner|implementer|tester|boss)-/;

export function listJsonlFiles(logsDir, ws) {
  try { return new Set(readdirSync(path.join(logsDir, ws)).filter(f => f.endsWith('.jsonl'))); } catch { return new Set(); }
}

/**
 * Scrape every JSONL log this run produced (see the snapshot-diff rationale in e2e.mjs:
 * one /chat call under config.agents produces one file per spawned frame plus the
 * dispatch's own narrative).
 *
 * Returns the run's status/finalAnswer plus a COST vector and a FRICTION vector. Speed
 * is in the cost vector and deliberately NOT in the score (EVAL-PLAN §3.1): it is
 * confounded by Docker-vs-host isolation and was the only term that ever moved the old
 * 0-100 number, which made a "quality" rubric into a noisy container-overhead meter.
 */
export function runMetrics(logsDir, ws, newFiles) {
  const dir = path.join(logsDir, ws);
  const counts = Object.create(null);
  const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  for (const spec of WARNING_INTERVENTIONS) counts[spec.key] = 0;
  for (const spec of REJECTION_INTERVENTIONS) counts[spec.key] = 0;
  counts.capHit = 0; counts.rejectedTotal = 0; counts.rejectedUnclassified = 0;
  counts.rejectedUnflagged = 0; counts.warnUnmatched = 0; counts.errorsOther = 0;
  // Structured-field counters (see the block above) — no pattern, no rot.
  for (const k of ['tasksPlanned', 'tasksReplanned', 'tasksAdvanced', 'bossInject', 'bossRestart',
    'bossEscalate', 'dispatchReplan', 'criticRevise2', 'criticGamedOracle', 'criticTotal',
    'itersDisagree']) counts[k] = 0;

  let plan = 0, iters = 0, toolCalls = 0, errors = 0, frames = 0;
  let maxCtx = 0, compactions = 0, evictions = 0, genTokens = 0, genMs = 0, topStatus, finalAnswer = '';
  let taskGraphs = 0, taskGraphMaxSteps = 0, taskGraphSingleStep = 0;
  const unmatchedSamples = new Set();

  for (const f of newFiles) {
    let meta = {}, fileIters = 0;
    let lines;
    try { lines = readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let e; try { e = JSON.parse(line).event || {}; } catch { continue; }
      switch (e.type) {
        case '__meta__': meta = e; break;
        case 'plan': plan++; break;
        case 'iteration': fileIters = e.current; break;
        case 'compact':
          if (EVICTION_RE.test(e.summary || '')) evictions++; else compactions++;
          break;
        case 'token_usage':
          maxCtx = Math.max(maxCtx, e.prompt_tokens || 0);
          genTokens += e.generated_tokens || 0;
          genMs += e.eval_duration_ms || 0;
          break;
        case 'error': {
          errors++;
          if (CAP_HIT_RE.test(e.message || '')) bump('capHit'); else bump('errorsOther');
          break;
        }
        case 'warning': {
          const msg = e.message || '';
          const hit = WARNING_INTERVENTIONS.find(s => s.re.test(msg));
          if (hit) bump(hit.key);
          else { bump('warnUnmatched'); if (unmatchedSamples.size < 5) unmatchedSamples.add(msg.slice(0, 60)); }
          break;
        }
        case 'tool_result': {
          // Primary path: the STRUCTURED `rejected` flag (types.ts:26), introduced by
          // e045d0a. Censused: 262 of 2698 September tool_results carry it; ZERO July
          // tool_results have the key at all (pre-e045d0a, rejections were `warning`s —
          // which `legacyPlanGate`/`legacySteer` above cover). So the total cannot go to
          // zero from a rewording.
          //
          // Fallback: a rejection MESSAGE with no `rejected` flag. Counted as
          // `rejectedUnflagged` so that if the flag is ever dropped while the wording
          // stays, the number moves columns instead of vanishing. Verified safe against
          // false positives: all 165 July `tool_result.error` values are genuine tool
          // errors ("Command failed", "old_string not found in …"), none of which match a
          // rejection pattern.
          const hit = REJECTION_INTERVENTIONS.find(s => s.re.test(e.error || ''));
          if (e.rejected === true) {
            bump('rejectedTotal');
            if (hit) bump(hit.key); else bump('rejectedUnclassified');
          } else if (hit) {
            bump('rejectedTotal'); bump('rejectedUnflagged'); bump(hit.key);
          }
          break;
        }
        // ── Structured interventions (no regex) ──
        case 'tasks':
          if (e.action === 'planned') bump('tasksPlanned');
          else if (e.action === 'replanned') bump('tasksReplanned');
          else if (e.action === 'advanced') bump('tasksAdvanced');
          break;
        case 'boss_verdict':
          if (e.action === 'inject') bump('bossInject');
          else if (e.action === 'restart') bump('bossRestart');
          else if (e.action === 'escalate') bump('bossEscalate');
          break;
        case 'replan': bump('dispatchReplan'); break;
        case 'critic':
          bump('criticTotal');
          if (e.verdict === 'revise') bump('criticRevise2');
          if (e.gamed_oracle === true) bump('criticGamedOracle');
          break;
        case 'task_graph':
          taskGraphs++;
          if (Array.isArray(e.steps)) {
            taskGraphMaxSteps = Math.max(taskGraphMaxSteps, e.steps.length);
            if (e.steps.length <= 1) taskGraphSingleStep++;
          }
          break;
        case 'done':
          if (!FRAME_SESSION_ID.test(meta.sessionId || '')) finalAnswer = e.content || finalAnswer;
          break;
        default: break;
      }
    }
    frames++;
    // LLM turns for this frame. TWO independent sources, both present in the logs:
    // the last `iteration.current` event and `__meta__.iterations`. Censused over 120
    // September logs they ALWAYS agree where both exist (3|3, 4|4, 15|15, 60|60 …), so
    // `max` is a no-op today and becomes a repair if one side is ever missing — `meta` is
    // written last (so it is what a truncated log loses) while `iteration` is written as
    // the run goes. Disagreements are counted rather than silently resolved.
    //
    // 34 of 200 sampled September logs have NEITHER: they are the top-level DISPATCH
    // narrative (start/objective/task_graph/boss_verdict/done), which runs no ReAct loop
    // of its own. 0 is the right answer for those — confirmed globally, September has
    // 2874 `ollama_request` and 2874 `iteration` events, so every real LLM call lives in a
    // file that does carry iteration events and nothing is lost by summing per file.
    const metaIters = Number(meta.iterations) || 0;
    if (fileIters && metaIters && fileIters !== metaIters) bump('itersDisagree');
    iters += Math.max(fileIters, metaIters);   // SUM across frames — total LLM-call volume
    toolCalls += meta.toolCalls || 0;          // == the frame's own tool_call count (verified 10 == 10)
    if (!FRAME_SESSION_ID.test(meta.sessionId || '')) topStatus = meta.status;
  }

  const tokPerSec = genMs > 0 ? Math.round(genTokens / (genMs / 1000)) : null;

  // "Gate round-trips": the forced extra model turns the supervision stack costs. Defined
  // EXPLICITLY as summary-ask + task-advance + final-reconciliation + done-gate re-ground,
  // which is the sum EVAL-PLAN §1.5 measured at 278 for September. Named here so the
  // number can never drift from its definition.
  const gateRoundTrips = counts.summaryAsk + counts.taskAdvance + counts.reconcile + counts.reground;

  const friction = {
    rejectedTotal: counts.rejectedTotal,
    planGate: counts.planGate,
    roleReject: counts.roleReject,
    loopSkip: counts.loopSkip,
    rejectedUnclassified: counts.rejectedUnclassified,
    rejectedUnflagged: counts.rejectedUnflagged,
    loopL0: counts.loopL0, loopL1: counts.loopL1, loopL2: counts.loopL2,
    nearDup: counts.nearDup,
    progressCheck: counts.progressCheck, stall: counts.stall, noProgress: counts.noProgress,
    verifyPass: counts.verifyPass, verifyFail: counts.verifyFail,
    summaryAsk: counts.summaryAsk, taskAdvance: counts.taskAdvance,
    reconcile: counts.reconcile, reground: counts.reground,
    criticRevise: counts.criticRevise, groundingRevise: counts.groundingRevise, layoutRevise: counts.layoutRevise,
    legacySteer: counts.legacySteer, legacyPlanGate: counts.legacyPlanGate,
    capHit: counts.capHit,
    gateRoundTrips,
    // Structured (field-matched, cannot rot). tasksAdvanced != taskAdvance by design —
    // see the note above the STRUCTURED block.
    tasksPlanned: counts.tasksPlanned, tasksReplanned: counts.tasksReplanned, tasksAdvanced: counts.tasksAdvanced,
    bossInject: counts.bossInject, bossRestart: counts.bossRestart, bossEscalate: counts.bossEscalate,
    dispatchReplan: counts.dispatchReplan,
    criticTotal: counts.criticTotal, criticReviseStructured: counts.criticRevise2,
    // The critic's OWN oracle-tampering detector. It has returned true ZERO times in 35
    // July critic events and has not run at all since (0 critic events in September), so
    // it is the second tamper detector in this project with no observed firing — the first
    // being the integrity check this batch replaced. Now that the deterministic gate can
    // fire, disagreement between the two is informative in both directions.
    criticGamedOracle: counts.criticGamedOracle,
    // Non-zero means the two independent LLM-turn sources disagreed — a log-integrity
    // signal, not a harness behaviour. Should always be 0.
    itersDisagree: counts.itersDisagree,
    warnUnmatched: counts.warnUnmatched,
    warnUnmatchedSamples: [...unmatchedSamples],
    infraWarn: counts.infraWarn,
  };

  const cost = { iters, toolCalls, frames, wallMs: null, genTokens, tokPerSec, maxCtx, compactions, evictions, peakRssMb: null };

  // Decomposition width, recorded now because it is free and because it is BATCH 2's exit
  // criterion (">= 2 steps and >= 2 implementer delegations"). Measured baseline to beat:
  // 84 of 85 September task graphs had exactly ONE step.
  const decomposition = { taskGraphs, taskGraphMaxSteps, taskGraphSingleStep };

  return {
    status: topStatus, finalAnswer, plan, errors, cost, friction, decomposition,
    iters, toolCalls, frames, maxCtx, compactions, evictions, tokPerSec,
  };
}
