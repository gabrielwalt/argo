# Testing gaps — where to add coverage next

Coverage map (as of 2026-09-08): every `src/*.ts` file has a same-named or cross-referenced test file
except the ones below. Ordered by risk × size — biggest, most load-bearing, or most security-relevant
gaps first.

## 1. `src/tools/index.ts` (261 lines) — no test file

The tool-dispatch switch (`executeTool`) every single tool call routes through. Only ever exercised
indirectly, through full scripted agent runs in `agent.test.ts`/`dispatch.test.ts` — there is no
direct test of its own routing logic.

Propose `src/tools/index.test.ts`:
- `executeTool('bash', ...)`, `('read_file', ...)`, etc. each reach the real underlying
  implementation (can mock/stub the underlying tool modules, or just assert the right module's
  exported function was the one that produced the result for a trivial no-op call per tool).
- An unrecognized tool name fails predictably (returns `{ output: '', error: ... }`, never throws).
- `runLedgerTool`'s sub-actions (`get_objective`, `get_recent`, `get_msg_id`, `messages`, `expand`)
  each branch correctly, including their own error paths (missing `frameId` in `LedgerToolContext`,
  an unknown sub-action name).

## 2. `src/al-logger.ts` (409 lines) — no test file

Mostly pure Markdown-formatting functions: `escapeMd`, `formatOptions`, `formatTools`, `blockquote`,
`formatToolCall`. Deterministic input → output, cheap to test, currently zero coverage on the
largest untested file in the codebase.

Propose `src/al-logger.test.ts`:
- `escapeMd`: markdown-special characters (`*`, `_`, `` ` ``, `#`, `[`, `]`, pipe `|` inside a table
  cell) escape correctly; a plain string round-trips unchanged.
- `formatOptions`/`formatTools`: given a representative `ModelOptions`/`AlToolDef[]`, output contains
  the expected fields in the expected shape.
- `blockquote`: multi-line input gets `>` prefixed on every line, including an empty line.
- `formatToolCall`: a call with a long/multi-line argument value gets appropriately truncated or
  code-fenced (whatever the current behavior is — pin it so a future change is deliberate, not
  accidental).
- `TraceLogger`'s public methods (`beginTurn`, `logEvent`, `logResponse`) — at minimum, that calling
  them doesn't throw and produces file content containing the logged data, since this class currently
  has no coverage at all.

## 3. `src/auth.ts` (85 lines) — no test file, security-relevant

Password-gate/cookie auth. Completely untested, and the one place a mistake would be a genuine
security regression (auth bypass, open redirect).

Propose `src/auth.test.ts`:
- `parseCookies`: no header → `{}`; one cookie; multiple cookies; a malformed pair (no `=`) is
  skipped, not thrown on; a URL-encoded value decodes correctly.
- `requireAuth`:
  - Valid `argo_auth` cookie → calls `next()`.
  - Valid `X-Argo-Password` header → calls `next()`.
  - `/login` and any `/internal/*` path → always calls `next()`, regardless of auth state.
  - No valid auth, `GET` + `Accept: text/html` → redirects to `/login?next=<encoded original path>`.
  - No valid auth, non-`GET` or non-html-accepting request → `401 { error: 'Unauthorized' }`, no
    redirect.
- Login POST flow (`installAuth`'s `/login` handler):
  - Correct password → sets the `argo_auth` cookie and redirects to `next`.
  - Wrong password → re-renders the login page with an error, no cookie set.
  - **The open-redirect guard specifically**: `next=https://evil.com` (or any value not starting
    with `/`) must fall back to `/`, never redirect off-origin. This is the one test in this whole
    gap list that's a genuine security regression test, not just a coverage nicety.

## 4. `src/tools/web-search.ts`, `browser-fetch.ts`, `fetch-url.ts` — no test file

Unlike `bash.ts`/`file-ops.ts` (both well-tested), these three tools have zero coverage. Propose
mirroring the existing shape of `bash.test.ts`/`file-ops.test.ts`:
- Argument validation (missing/malformed required args → a clean `{ error: ... }`, never a throw).
- Truncation/`MAX_OUTPUT`-equivalent behavior on an oversized result.
- Error-result shape on a real failure (network error, Playwright launch failure, missing Tavily key)
  — confirm it's always `{ output, error? }`, matching this project's own tool-output convention
  (CLAUDE.md's "Tool output conventions" / the `argo-add-tool` skill).
- `browser-fetch.ts` specifically: since it shells out via `spawn` with stdin (not `exec`, precisely
  to dodge quoting/escaping issues — see CLAUDE.md's "What NOT to do") a good regression test is one
  URL/waitFor argument containing a quote or backtick, confirming it doesn't break the generated
  script.

## 5. `src/health.ts` (47 lines) — lower priority

Mostly thin wrappers around real `exec`/`fetch` calls (`checkOllama`, `checkDocker`, `checkGit`) —
genuinely hard to unit-test meaningfully without mocking child_process/fetch, and low value to do so
(a real health check failing here means Ollama/Docker/git actually aren't there, which is exactly
what the check is supposed to report). The two purely-logical parts are cheap and worth covering:
- `logEnvironment`: formatting for all-ok (no `⚠`) vs. any-`false` (`⚠` prefix, `✗` marker on the
  failed one).
- `checkEnvironment`'s branching: `config.inContainer === true` skips the Docker check entirely
  (resolves `true` without calling `checkDocker`).

## Not proposed

`src/types.ts` (pure type/interface declarations, nothing to execute) and `src/index.ts` (8-line
entry point, routes to central/worker/standalone — nothing to unit-test in isolation) are correctly
uncovered; no test file is warranted for either.
