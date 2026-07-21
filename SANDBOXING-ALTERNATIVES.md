# Sandboxing alternatives to Docker

**Status: exploratory only — Argo stays on Docker for now.** This document exists so the reasoning isn't lost, not because a migration is planned. Revisit if per-workspace memory/startup cost becomes a real practical problem, if the Docker Desktop dependency itself becomes friction, or if Linux/Windows support is ever needed.

## The question that started this

Docker's per-workspace container costs real memory and startup time (see "What's actually true about Docker today" below), and the "lean by default" principle in CLAUDE.md asks us to prefer lighter options when they don't cost real capability. Is there a lighter execution model for the agent's tools that still confines it to its mounted folder?

## What's actually true about Docker today

Worth stating plainly, since it's easy to overclaim: Docker gives Argo real, kernel-enforced **filesystem** confinement (only `/workspace`, `/scratch`, `/app/logs` are mounted) and, incidentally, a reproducible Linux userland on top of macOS (the whole CLI toolchain in CLAUDE.md's ENVIRONMENT section — ripgrep, jq, git, node with pre-installed packages — exists *because* it's baked into the image, not because it's guaranteed on the host). It does **not** give network isolation (no `--network` restriction — containers get normal outbound internet access) or resource limits (no `--memory`/`--cpus`/`--pids-limit`). Any alternative needs to be judged against what Docker *actually* provides, not the idealized version.

## Approaches explored, and why each falls short somewhere

**Slicc's approach (researched directly — `/Users/gwalt/Sources/adobe/slicc`).** A pure-TypeScript bash interpreter (`just-bash`) over a virtual filesystem (`@zenfs` on OPFS), running entirely in a browser tab. No real subprocess spawning, no real Node runtime, no native npm modules, no raw sockets. Notably, Slicc's own architecture defers to **real sandboxes (E2B, Cloudflare Containers)** for its server-side "cloud" execution tier — i.e., even Slicc's authors didn't treat a JS-interpreted shell as a substitute for real isolation when genuine OS-level capability is needed. It works for Slicc because Slicc has *zero* server-side footprint (nothing runs outside the user's browser); that's not Argo's situation.

**Node's built-in `--experimental-permission` flags.** Real, no Docker needed: `--allow-fs-read=/path --allow-fs-write=/path` restricts every call through Node's own `fs` module to an allowlist, checked at the runtime level. The gap: it's a *cooperative* check inside Node's own API surface. A `child_process.spawn()` from that same process is a normal, fully-privileged OS process — the permission flags don't propagate to subprocesses or native addons at all. You can close that specific hole by also blocking `--allow-child-process`/`--allow-addons`, but then you've given up exactly the "run arbitrary code" flexibility that's the point.

**WASM/WASI's preopen model.** Stronger than Node's permission flags in one specific way: a WASI module is only ever handed file descriptors for directories explicitly granted at instantiation — there's no raw syscall in its instruction set capable of naming a path outside that tree, so there's no "check that could be bypassed," the *capability* simply doesn't exist. Good for pure computation + file I/O. Same ceiling as everything else here: no real subprocess spawning, no npm package with native bindings, no real git-over-SSH.

**Exposing a `spawn_process` host import to WASM.** Mechanically trivial — WASI's whole model is "the guest only has what you hand it as an import." But this is where it's important not to fool ourselves: once the guest can ask the host to run an arbitrary real process with arguments the LLM chose, **the WASM sandbox contributes nothing to that specific capability** — it's a message-passing hop, not a boundary. The security boundary has to live entirely in the host's implementation of `spawn_process`.

**`sandbox-exec` (macOS Seatbelt) as what `spawn_process` actually launches through.** This is the piece that makes the above workable: Apple's kernel-level MAC sandboxing (same tech as App Sandbox, used internally by many system daemons). A profile can express real file read/write confinement to one directory tree, and — usefully — **child processes inherit the parent's profile automatically**, so `npm install` → `node-gyp` → a compiler → whatever it spawns all stay confined without having to catch and re-wrap each one individually. Real, workable friction points:
- **Playwright/Chromium specifically doesn't fit.** Chromium has its own internal Seatbelt-based sandboxing for its renderer processes; nesting a sandboxed Chromium inside an *external* `sandbox-exec` wrapper is known to be unreliable and typically forces `--no-sandbox` on Chromium, defeating the point. Conclusion: keep Playwright as its own separate, un-nested service (the user's own suggestion, and the right call) rather than routing it through the same path as everything else.
- **Profile maintenance is an ongoing cost, not a one-time setup.** Real dev tooling needs allow-listing for `~/.npm`, node-gyp's cache, Xcode Command Line Tools (needed to compile any native npm module), Homebrew's prefix, macOS's scattered `/private/var/folders/...` temp paths. Miss one and you get a sandbox-denial failure that's genuinely hard to diagnose. Expect to iterate on the profile as new tools surface new gaps, not to write it once.
- **Deprecated-but-functional.** Undocumented and technically deprecated by Apple since ~2017, still alive and load-bearing in current macOS, still relied on by tools like Nix and Bazel for exactly this purpose. Reasonable to build on today; not a permanent guarantee — no portable equivalent exists (Linux's equivalent would be bubblewrap/namespaces; no clean Windows equivalent).
- **Background/long-running processes** aren't a sandboxing limitation at all (confinement holds fine for a detached process) — it's an API design point: `spawn_process` would need to return a handle/PID rather than being a simple synchronous call, so the caller can poll or kill it later.

**`isomorphic-git`** (pure JS, no real `git` binary) resolves the one git-related requirement that actually matters here — committing after every run — entirely without subprocess spawning. Same library Slicc uses for the same reason. Worth noting explicitly: Argo's auto-commit already runs *outside* the LLM's own tool-calling (it's `agent.ts`'s own post-run logic, not something the model decides to invoke), so this was never actually a constraint on the sandbox design in the first place.

## Where the line would fall, if this were built

**No subprocess needed:** file CRUD, text/JSON/YAML processing, grep-like search, diffing, small computational scripts (via an embedded JS interpreter, e.g. QuickJS-in-WASM — what Slicc uses), git status/diff/add/commit via isomorphic-git, calls to any deliberately-exposed host API (the existing `web_search` shadow-proxy pattern, generalized).

**Needs `spawn_process` → `sandbox-exec`:** `npm install` for real (native bindings, install scripts), running the project's actual build/test/dev tooling, arbitrary improvised shell pipelines, long-running background processes.

**Should stay a separate, differently-handled service regardless:** Playwright/Chromium.

Honest framing of that split: for a coding agent actually working on real projects, the "needs a subprocess" bucket isn't a rare edge case — running the project's own tests and build *is* most of what makes the agent useful. The sandbox mainly makes the agent's own scratch work and file edits cheap and structurally safe; it doesn't reduce how often real subprocess execution is needed, since verifying code actually works requires the real toolchain almost every turn.

## Would qwen3.6 (or similar) work as well in this harness?

Model-side, yes in principle — tool-calling quality is a property of the model and the tool schema, not of what executes underneath a tool call. Two things would need deliberate handling to avoid a *real* (non-model) regression:

1. **Toolchain parity.** The system prompt promises a specific curated CLI/npm set because that's what's in the Docker image. Host-direct execution runs against whatever's actually on the Mac; a mismatch means the model hits "command not found" more often — extra iterations, not a capability loss, but a real cost if not managed.
2. **Shell-session persistence.** A Docker container is one long-lived process for the whole session — `export FOO=bar` or a backgrounded `npm run dev &` in one `bash` call is still visible on the next call. If `spawn_process` naively spawns an independent subprocess per call, none of that persists. This needs to be a deliberate design choice (one persistent shell/pty per workspace that commands are written into) rather than an accident of the simplest implementation — easy to get wrong silently.

File-level state (anything written to disk) is fine either way, since `/scratch`/`/workspace` map to real folders regardless of what wraps the process.

## Net assessment

Real potential wins: lower memory/startup footprint per workspace (no standing container, no image), likely lower per-tool-call latency (no Docker daemon RPC hop), no separate image-build step to forget (the stale `dist/`+image bug hit during this same work session — a real, concrete cost of the current setup, not hypothetical).

Real costs: loses Docker Desktop's reproducible Linux-on-Mac userland; `sandbox-exec` is macOS-only and Apple-unsupported (though currently functional and in active use elsewhere); ongoing sandbox-profile maintenance burden; no improvement on network/compute isolation over what Docker already does (or doesn't) provide.

**Decision: not worth the migration cost right now.** Keep this document as the reference if that calculus changes.
