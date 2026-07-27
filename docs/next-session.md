# Next session — pick up here (Phase 4: quality supervision)

Parked 2026-07-27. Everything below is committed; the machine is at baseline
(`ARGO_CRITIC` off, workers on the new image, no jobs/crontasks running).

## TL;DR — where we are
Phase 4 = **quality of long/complex tasks over speed**. Two sub-steps done:
1. **Supervisor eval (DONE).** LLM-as-judge picked the critic model: **qwen3.6 itself**
   is the ONLY model that reliably (3/3) flags oracle-gaming; devstral/gemma4/
   qwen2.5-coder/deepseek-r1 all fail that gate. (`docs/eval-log.md`; self-critique =
   zero extra memory on the 48 GB Mac.)
2. **Actor-critic (BUILT, flag-gated `ARGO_CRITIC`, default off).** qwen3.6 self-critique
   at 3 checkpoints (post-plan / on-stall / pre-done); pre-done blocks completion on
   oracle-tamper or unmet objective. `src/critic.ts` + `agent.ts`/`config.ts`/`logger.ts`/
   `types.ts` + `src/critic.test.ts` + `docs/actor-critic.md`. Typecheck ✓.

## The one open question → the immediate next step
**Does the critic actually IMPROVE long-task outcomes?** Unknown, because the A/B
run-1 was inconclusive: `bigproj-effort` now converges in ~24 iters (**high-variance,
not a reliable failure**), so baseline passed and there was nothing to rescue. The
critic *did* fire correctly (post-plan ok; on-stall gave a correct thrash diagnosis +
concrete guidance; pre-done ok; no false gaming flag; no regression) — so **functional
integration is proven; VALUE is not.**

**NEXT (tomorrow's first action):** a multi-run A/B in the *failing* regime.
- `EVAL_RUNS≈5` per condition, **`EVAL_MAX_ITER=90`**, `bigproj-effort` (+ `store-addTask`
  as a regression check), critic **OFF vs ON**.
- **Instrument the failure modes**, don't just count pass/fail: for each run tally
  compaction stalls/timeouts, drift (wrong modules), thrash (repeat cmds), self-revert
  (git checkout), and gaming attempts (edits to `*.test.*`). Compare incidence OFF vs ON,
  and how often the critic BLOCKED a bad finish (`critic` events, `gamed_oracle:true`).
- This does double duty: (a) the critic's real-regime A/B, and (b) it **tells us from data
  which lever to build next** instead of guessing.

## Research audit — what's already built vs. the untested levers
Checked `docs/research.md` against the code. Argo ALREADY implements the top research
levers, so do NOT rebuild them:
- Deterministic **tool-result collapsing** (keep live context lean — the #1 finding): `agent.ts:499–513`.
- **Structured compaction ledger** (facts/decisions/open-bugs/verified, persists across compactions): `compaction.ts` `CompactionState`.
- External file memory (`MEMORY.md`), plan/act gate, re-ground done-gate, stall re-ground.

**ADOPTED-but-untested research levers** (candidates for the NEXT lever, to be chosen by
the failure-mode data from the multi-run above):
1. **Route compaction to a smaller/faster model** — compaction uses the *main* model and
   the `config.ts` comments document it **timing out at 180–300s on big histories and
   re-triggering**. A known long-run bottleneck. (Research rec #3.)
2. **Goal/plan recitation** (Manus "todo.md") — re-inject objective + plan + next-step
   every N turns to fight drift; cheap (no LLM call), flag-gated. Argo only re-grounds
   periodically today.
- Also worth considering: **a harder, genuinely long-horizon eval task** — `bigproj-effort`
  is too easy now (~24 iters), so it can't stress any long-task lever. A reliable
  long/failing task would sharpen every future measurement (e.g. the wind-sim debug in
  `test-two`, or a new multi-file feature).

## How to run the multi-run (turnkey via the host bridge)
The `slicc-exec` MCP (v1.2) is the host bridge — 6 tools: `run`, `run_bg`, `job_tail`,
`jobs`, `job_kill`, `machine_status`. Long jobs MUST use `run_bg` (60s call cap).
- A working A/B driver template is at `scratch/run-ab.sh` (restart-workers race already
  fixed: it waits for the old container to disappear after `argo detach` before `argo
  attach`). **Edit it for the real run:** set `EVAL_MAX_ITER=90` and `EVAL_RUNS=5` in
  `run_eval`, and add the failure-mode tally (grep the per-run bigproj logs for
  compaction/thrash/self-revert/`"type":"critic"`/`gamed_oracle`).
- Flag injection: the worker reads `ARGO_CRITIC` from `~/.config/argo/env` (central
  forwards non-secret global-env vars into the worker container). The script sets/removes
  it and restarts the two eval workers between phases.
- Launch: `mcp invoke slicc-exec run_bg --command "bash ~/Sources/adobe/argo/scratch/run-ab.sh" --label argo-ab3`.
- Poll: `mcp invoke slicc-exec job_tail --job_id argo-ab3`. **Cone-push is DOWN** (tray hub
  disconnected), so poll `job_tail`; the resume pattern used today was a `crontask`
  (no `--scoop` → routes to the cone) firing every ~7 min to auto-collect, then deleted
  when done.
- Eval workspaces: `bigproj` = `~/Sources/test/bigproj` (bigproj-effort), `test-one` =
  `~/Sources/test/test-one` (store-addTask). Eval command per task:
  `ARGO_PASSWORD=<from ~/.config/argo/env> EVAL_TASKS=<id> EVAL_MAX_ITER=90 EVAL_RUNS=5 node scripts/eval-e2e.mjs`.
  (`node scripts/eval-e2e.mjs` directly — avoids a broken pnpm `.bin` state; see gotcha.)

## Gotchas / environment state to re-establish
- **Restart the `slicc-exec` MCP server** in a new session if needed: it runs on the Mac
  (`~/Sources/adobe/slicc-exec-mcp`, `node server.mjs`), launched with
  `SLICC_EXEC_NOTIFY_URL=https://www.sliccy.ai/webhooks/8p4maybb8inh`. Then the cone runs
  `mcp refresh slicc-exec` (or `mcp add http://127.0.0.1:8765/s/<secret>/mcp slicc-exec`).
  Secret at `/mnt/slicc-exec-mcp/.slicc-exec.secret`.
- **Broken pnpm `.bin`:** `node_modules/.bin/tsc`/`tsx` symlinks are missing (pnpm reports
  "already up to date" and won't relink). Build via `node node_modules/typescript/bin/tsc`
  instead of `pnpm build`; `argo rebuild` (docker) is unaffected. Worth a real
  `pnpm install --force` sometime to fix it.
- **Rollout for a src change:** `node node_modules/typescript/bin/tsc` (or fix pnpm then
  `pnpm build`) → `argo rebuild` → restart workers (`argo detach <path>`; wait for the
  container to be gone; `argo attach <path>` — attach blocks until "Ready").
- Git author for this repo = **Gabriel Walt <gabriel.walt@gmail.com>** (isomorphic-git on
  the mount: no `--amend`/`reflog`/`HEAD~1`; reset+recommit to re-author).
- `mcp-jobs` scoop = idle job-completion relay (webhook `sliccy.ai/webhooks/8p4maybb8inh`
  + an `fswatch` on `/mnt/slicc-exec-mcp/.jobs`), inactive until the tray hub reconnects.

## Commits this session (all gmail-authored, unpushed)
- supervisor eval scaffold + run + docs (`dec4968`, `3747dfe`)
- actor-critic feature behind `ARGO_CRITIC` (`3e1714a`)
- actor-critic A/B run-1 eval-log entry (`b441540`)
