# MEMORY.md — Persistent learnings for future sessions

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Server files are in `src/` (TypeScript, compiled to `dist/`). Source is the authoritative target — never modify `dist/` directly.
- Docker image (`docker/agent.Dockerfile`): keep download-heavy layers ABOVE the app COPY layers. `argo rebuild` reuses the layer cache; `argo rebuild --fresh` forces a full `--no-cache --pull` rebuild.

## Model
- Target model: `qwen3.6:latest` — the only model validated end-to-end across the dispatch pipeline.
- Ollama streaming: `tool_calls` arrive on chunk N-1 (NOT the terminal `done:true` chunk). Accumulate via `if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls`.
- `think: false` works for disabling thinking mode (must be TOP-LEVEL in request, not inside options).
- `num_predict: 16384` caps per-turn generation (prevents thinking models from consuming entire context) — set per-model in `agent.ts`'s `MODEL_PRESETS`, not a global default.

## Context management gotcha
- A flat chars-per-token constant is NOT reliable for deciding when to compact — confirmed live (2026-09-18): real usage hit 92% while the flat-3.5 estimate never crossed its own 60% trigger, so eviction never ran. It's blind to tool-schema overhead (never part of `this.history`) and to content-density swings (dense math/code tokenizes much denser than prose). Fixed by self-calibrating against real `prompt_eval_count` every turn (`agent.ts`'s `effectiveCharsPerToken`) instead of trusting a fixed ratio — see CLAUDE.md's "Context eviction" for the full mechanism.

## Reasoning-reinjection gotcha
- A pushed `Message`'s own `thinking` field does NOT reliably survive into the model's NEXT request — confirmed live (2026-09-18): whenever a turn also produced real `content`, the attached `thinking` silently failed to reach later context. Reasoning must be reinjected as explicit `[Reasoning]`-prefixed `content` instead (the one channel proven to survive) — see CLAUDE.md's "Reasoning-artifact reinjection".

## Loop-ladder gotcha
- A duplicate/no-progress tool call is now actually RE-EXECUTED for real at every ladder rung except the one cached L0 replay (`maxReplaysPerKey`, default 1) — it used to fabricate a "SKIPPED" error and suppress the real result once that one replay's budget was spent, which left the model with nothing useful once the earlier real result aged out of context. See CLAUDE.md's "Loop recovery".

## Dispatch gotchas
- `Agent.setMaxIterations` has a hard floor of 10 — smaller values are silently clamped.
- `autoCommit()` moves HEAD forward mid-run. Diff against a pre-run baseline ref, never bare HEAD.
- The Dispatcher's task-start checkpoint: `agent.getConcludeStatus()` is authoritative; the regex parse of ANSWER/SIMPLE/OBJECTIVE is only a fallback.
- Ollama's `abort()` only cancels streaming requests — non-streaming requests stay open after timeout rejection.
