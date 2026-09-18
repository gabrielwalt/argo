---
name: argo-troubleshooting
description: Diagnose common Argo problems — agent not calling tools or outputting JSON as text, poor multi-step reasoning, browser_fetch failures, bash returning empty output, SSE stuck on "Connecting…", port conflicts, redirect loops, Dockerfile/pnpm build issues. Use when Argo is behaving unexpectedly or a specific error/symptom below matches what's happening.
---

# Argo common debugging

**`argo attach` behaves like an old version — bugs long since fixed still reproduce**
→ `bin/argo`'s CLI flow runs `dist/index.js` (compiled) and `argo:latest` (a prebuilt Docker image) — neither updates automatically when `src/` changes. `pnpm dev` (tsx watch) is the only path that reflects source instantly; central/worker mode does not. After any change that matters for real usage, run `pnpm build` and `docker build -f docker/agent.Dockerfile -t argo:latest .` (or `argo rebuild` for just the image) before testing through the actual `argo` CLI — otherwise you're debugging against stale code and won't find anything.

**Argo not calling tools / outputting JSON as text**
→ Switch to `qwen3.6:latest` — the only model validated for agentic use in Argo. See README Models table for full findings per model.

**Agent writes scripts but doesn't run them / declares done on empty output / poor multi-step reasoning**
→ Model capability issue. Gemma3/4 models cannot follow the ReAct loop — they lose cause-and-effect across iterations and ignore the system prompt. `gemma3:12b` returns a hard Ollama error ("does not support tools"). Use `qwen3.6:latest`.

**bash tool returning empty output**
→ Standalone: check `docker ps` — container may be stopped. Run `docker start argo-sandbox`.
→ Worker: check `docker ps | grep argo-` and `docker logs argo-{name}`.

**browser_fetch failing**
→ `docker exec argo-{name} node -e "require('playwright'); console.log('ok')"` to verify install.

**`require('pkg')` not found in argo script**
→ Must use `require()` not `import`. Verify `NODE_PATH`: `docker exec argo-{name} printenv NODE_PATH`.

**Port conflict on startup**
→ `lsof -ti :3000 | xargs kill -9`

**Central server fails to start**
→ `cat ~/.local/share/argo/server.log`

**SSE "Connecting…" forever through the proxy**
→ Two causes fixed in `proxyToWorker`: (1) For GET requests, use `proxy.end()` directly — don't use `req.pipe(proxy)` because `req` may have already emitted `end` (due to the `await loadRegistry()` before calling the proxy), and piping an already-ended stream never calls `proxy.end()` so the worker never gets a complete request and never sends headers. (2) Strip hop-by-hop headers (Connection, Transfer-Encoding, etc.) and set `accept-encoding: identity` on the proxied request to prevent the worker from gzip-encoding the SSE stream. Call `res.flushHeaders()` after `res.writeHead()` to send the 200 + SSE headers to the browser immediately.

**ERR_TOO_MANY_REDIRECTS on /ws/:name/**
→ `app.set('strict routing', true)` missing from the Express app in `startCentral()`.

**Root URL serves index.html instead of workspaces.html**
→ `express.static` must be called with `{ index: false }` in `startCentral()`.

**pnpm install blocked in Dockerfile**
→ Dockerfile uses `npm install --ignore-scripts` (not pnpm) — pnpm v11 blocks esbuild postinstall.
