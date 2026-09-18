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
- `num_predict: 8192` caps per-turn generation (prevents thinking models from consuming entire context).

## Context management gotcha
- A flat chars-per-token constant is NOT reliable for deciding when to compact — confirmed live (2026-09-18): real usage hit 92% while the flat-3.5 estimate never crossed its own 60% trigger, so eviction never ran. It's blind to tool-schema overhead (never part of `this.history`) and to content-density swings (dense math/code tokenizes much denser than prose). Fixed by self-calibrating against real `prompt_eval_count` every turn (`agent.ts`'s `effectiveCharsPerToken`) instead of trusting a fixed ratio — see CLAUDE.md's "Context eviction" for the full mechanism.

## Dispatch gotchas
- `Agent.setMaxIterations` has a hard floor of 10 — smaller values are silently clamped.
- `autoCommit()` moves HEAD forward mid-run. Diff against a pre-run baseline ref, never bare HEAD.
- The Dispatcher's task-start checkpoint: `agent.getConcludeStatus()` is authoritative; the regex parse of ANSWER/SIMPLE/OBJECTIVE is only a fallback.
- Ollama's `abort()` only cancels streaming requests — non-streaming requests stay open after timeout rejection.
