const $ = id => document.getElementById(id)

// API base — empty in standalone dev mode, '/ws/{name}' when served by central server
const API_BASE = window.__WS__ ? `/ws/${window.__WS__}` : ''

const messagesEl = $('messages')
const inputEl = $('input')
const sendBtn = $('send-btn')
const statusDot = $('status-dot')
const statusText = $('status-text')
let selectedModel = ''
const iterLabel = $('iter-label')
const gitLog = $('git-log')
const diffModal = $('diff-modal')
const diffContent = $('diff-content')
const diffTitle = $('diff-title')
const ctxFrameBar = $('ctx-frame-bar')
const ctxFrameSelect = $('ctx-frame-select')
const ctxFrameHint = $('ctx-frame-hint')
const tokenCounter = $('token-counter')
const indicatorArea = $('indicator-area')
const settingsPanel = $('settings-panel')

// ── Message-list scroll tracking ────────────────────────────────
// #messages force-scrolled to bottom on every append before this — fine
// while watching a run live, annoying once you've scrolled up to reread
// something and new trace items yank you back down. Track whether the user
// is at (or within NEAR_BOTTOM_PX of) the bottom; only auto-scroll when they
// already are there, and surface a floating button otherwise.
const scrollBottomBtn = $('scroll-bottom-btn')
const NEAR_BOTTOM_PX = 40
let messagesAtBottom = true

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= NEAR_BOTTOM_PX
}

messagesEl.addEventListener('scroll', () => {
  messagesAtBottom = isNearBottom()
  if (messagesAtBottom) scrollBottomBtn.classList.add('hidden')
})

// Call this instead of a bare `messagesEl.scrollTop = messagesEl.scrollHeight`
// after appending anything to #messages: keeps the stick-to-bottom behavior
// when the user is already there, and otherwise reveals the "new messages"
// button rather than yanking their scroll position around.
function maybeAutoScroll() {
  if (messagesAtBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight
  } else {
    scrollBottomBtn.classList.remove('hidden')
  }
}

scrollBottomBtn.addEventListener('click', () => {
  messagesAtBottom = true
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' })
  scrollBottomBtn.classList.add('hidden')
})

// ── Combined context + status indicator (donut) ────────────────────
// Latest context size the model saw. The donut's three rings are drawn from
// per-role state (ctxStateByRole) and redrawn on every token_usage; precise
// numbers live in the dropdown. The donut's CENTER communicates agent state
// (see indicatorState). frameId/role identify the owning frame when the
// reading came from a frame-tagged token_usage (see handleEvent), so the
// dropdown can always say WHOSE numbers it's showing rather than an
// unattributed count.
let ctxState = { promptTokens: 0, numCtx: 0, pct: 0, frameId: null, role: null }

// Per-agent-role context reading, one entry per concentric ring in the donut
// (see renderDonut). Updated from token_usage's __role tag; ctxState above
// stays the single most-recent reading (any role) for the dropdown.
let ctxStateByRole = {
  dispatcher:  { promptTokens: 0, numCtx: 0, pct: 0 },
  planner:     { promptTokens: 0, numCtx: 0, pct: 0 },
  implementer: { promptTokens: 0, numCtx: 0, pct: 0 },
}

// Fixed per-role color, used for that role's donut ring, its accordion
// heading (getOrCreateRoleCard), and its conclude card. Keep in sync with
// the CSS custom properties (--agent-dispatcher/planner/implementer) and the
// documentation block at the top of styles.css.
const AGENT_COLORS = {
  dispatcher:  '#f59e0b',  // amber/gold
  planner:     '#a78bfa',  // purple
  implementer: '#34d399',  // green/emerald
}

// Drives the donut's core color: 'ready' (green) / 'busy' (yellow, running) /
// 'compacting' (flashing violet) / 'error' (red). Set by setStatus(), except
// while compactingNow is true, which always wins (a compaction can happen
// mid-run, and should visually override "Running").
let indicatorState = 'ready'
// True while a 'compact' event's eviction pass is in flight, cleared by that same
// event (or a safety-net clear on the next 'iteration'/'error') — independent of
// `busy` since a manual compaction can run between agent runs. Deterministic
// eviction (src/eviction.ts) is in-memory and fast, so this window is normally
// too brief to see; kept as a safety net rather than removed.
let compactingNow = false
let compactStartTime = null
let lastCompactionDurationS = null

// HAL 9000-style donut: a solid glowing core (agent state) surrounded by
// three concentric rings, one per agent role — outer = Dispatcher, middle =
// Planner, inner = Implementer — each filled to that role's own context
// usage percentage, in that role's own fixed color (AGENT_COLORS).
function renderDonut() {
  const size = 40, cx = 20, cy = 20

  const rings = [
    { role: 'dispatcher',  r: 16, sw: 3 },
    { role: 'planner',     r: 12, sw: 3 },
    { role: 'implementer', r: 8,  sw: 3 },
  ]

  // Core: solid state color, filling the center like HAL's red eye. Glows to
  // match the state color (same "shiny" treatment as the home screen's status
  // dot) and pulses gently while busy/compacting; steady (just the glow)
  // while ready/idle.
  const coreColor = { ready: 'var(--green)', busy: 'var(--yellow)', compacting: 'var(--purple)', error: 'var(--red)' }[indicatorState] || 'var(--green)'
  const coreClass = indicatorState === 'compacting' ? 'ctx-core compacting'
    : indicatorState === 'busy' ? 'ctx-core running'
    : 'ctx-core'
  const coreR = 4

  let svg = `<svg class="ctx-donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`

  for (const ring of rings) {
    const state = ctxStateByRole[ring.role]
    const pct = Math.max(0, Math.min(100, state.pct))
    const circ = 2 * Math.PI * ring.r
    const dash = circ * (pct / 100)
    const color = AGENT_COLORS[ring.role]
    // Background ring (track)
    svg += `<circle cx="${cx}" cy="${cy}" r="${ring.r}" fill="none" stroke="var(--border)" stroke-width="${ring.sw}" opacity="0.3"/>`
    // Fill ring
    if (pct > 0) {
      svg += `<circle cx="${cx}" cy="${cy}" r="${ring.r}" fill="none" stroke="${color}" stroke-width="${ring.sw}"`
        + ` stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
    }
  }

  svg += `<circle class="${coreClass}" cx="${cx}" cy="${cy}" r="${coreR}" fill="${coreColor}" style="filter: drop-shadow(0 0 4px ${coreColor})"/>`
  svg += `</svg>`

  tokenCounter.innerHTML = svg
}

// Update stored context size + redraw. Precise numbers show in the dropdown;
// the donut itself only ever shows the three per-role rings (usage) and
// core+center-text (agent state / iteration). frameId/role identify which
// agent this reading belongs to (see ctxState above); omitted for an untagged,
// harness-level reading.
function updateCtx(promptTokens, numCtx, frameId = null, role = null) {
  if (role && ctxStateByRole[role]) {
    const pct = numCtx > 0 ? Math.round(100 * promptTokens / numCtx) : 0
    ctxStateByRole[role] = { promptTokens, numCtx, pct }
  }
  const pct = numCtx ? Math.round(promptTokens / numCtx * 100) : 0
  ctxState = { promptTokens, numCtx, pct, frameId, role }
  renderDonut()
}

// Compact k-token formatting for the dropdown's frame-owned reading, where the
// role name added ahead of it (see buildCtxDropdown) eats into the available
// width — the untagged, harness-level reading keeps the original full
// toLocaleString() format.
function fmtTokensK(n) {
  if (n == null) return '—'
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// Format a duration in ms for display. Under 60s: "12.3s" (one decimal).
// 60s and over: "2m 15s" (whole seconds, no decimals).
function fmtDuration(ms) {
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const min = Math.floor(totalSec / 60)
  const sec = Math.floor(totalSec % 60)
  return `${min}m ${sec}s`
}

// ── Confirm dialog / toast — replace native confirm()/alert() ────
function confirmDialog(message) {
  return new Promise(resolve => {
    const modal = $('confirm-modal')
    const okBtn = $('confirm-ok')
    const cancelBtn = $('confirm-cancel')
    $('confirm-message').textContent = message
    modal.classList.add('open')
    function cleanup(result) {
      modal.classList.remove('open')
      okBtn.removeEventListener('click', onOk)
      cancelBtn.removeEventListener('click', onCancel)
      resolve(result)
    }
    function onOk() { cleanup(true) }
    function onCancel() { cleanup(false) }
    okBtn.addEventListener('click', onOk)
    cancelBtn.addEventListener('click', onCancel)
  })
}

function showToast(message) {
  const container = $('toast-container')
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  container.appendChild(toast)
  requestAnimationFrame(() => toast.classList.add('visible'))
  setTimeout(() => {
    toast.classList.remove('visible')
    setTimeout(() => toast.remove(), 200)
  }, 4000)
}

// Full-view "Detaching <name>…" overlay — used by the current-workspace detach
// path, which navigates away, so the indicator stays visible even if the
// dropdown closes. Returns the element so callers can remove() it on failure.
function showDetachOverlay(name) {
  const overlay = document.createElement('div')
  overlay.className = 'detach-overlay'
  overlay.innerHTML = `<span class="ui-spinner lg"></span><span class="detach-overlay-text">Detaching ${escHtml(name)}…</span>`
  document.body.appendChild(overlay)
  return overlay
}

// ── Session state ────────────────────────────────────────────────
let sessionStartTime = new Date()
let currentSessionQuery = ''  // first user message of the current session

// ── Structured-event replay state ───────────────────────────
// The live SSE connection is the ONLY live delivery; the per-run JSONL logs are
// the canonical trace. On (re)entering the live view we replay persisted events,
// so live events arriving during that async replay are buffered here and flushed
// afterward. Dedup between replay and live uses each event's per-run `__seq`
// (the server attaches it to both the JSONL replay responses and the SSE
// stream): liveRunMaxSeq is the highest seq already rendered for the current
// run, reset to 0 when a new run's first event (per-run seq === 1) arrives.
let currentLiveSessionId = ''   // active (live) session id — whose persisted events to replay
let replaying = true            // true while replaying persisted events (buffer live SSE meanwhile); starts true for the initial page-load replay
let pendingEvents = []          // live SSE events received while replaying
let liveRunMaxSeq = 0           // high-water dedup mark for live vs. replayed events (current run)

// ── Model options ────────────────────────────────────────────────
const DEFAULTS = { temperature: 0.6, top_p: 0.95, top_k: 20, num_ctx: 65536 }
const modelOpts = { ...DEFAULTS }
const MAX_ITERATIONS_DEFAULT = 1000
let maxIterations = MAX_ITERATIONS_DEFAULT
// Grounding & self-consistency guard (writing/research tasks). Default ON; sent with
// every /chat request so the worker's per-run flag matches this toggle.
let grounding = true

// ── Settings dropdown — draft-then-apply ────────────────────────────
// The dropdown no longer live-applies: opening it seeds `settingsDraft` from
// the committed state (modelOpts/maxIterations/grounding/selectedModel);
// every control below writes into the draft only. Save copies the draft back
// into the committed variables (what the next /chat request sends) and
// closes; Cancel (or any outside-click/Escape close) just discards the draft
// and closes, leaving the committed state untouched. `null` means "closed".
let settingsDraft = null

function isSettingsOpen() { return settingsPanel.classList.contains('open') }

// Reflects the draft (while open) or the committed state (while closed) into
// the control DOM — used both when opening (seed) and after Reset.
function syncSettingsUI() {
  const src = settingsDraft || { ...modelOpts, maxIterations, grounding, model: selectedModel }
  $('opt-temperature').value = src.temperature
  $('opt-temperature-val').textContent = src.temperature.toFixed(2)
  $('opt-top-p').value = src.top_p
  $('opt-top-p-val').textContent = src.top_p.toFixed(2)
  $('opt-top-k').value = src.top_k
  $('opt-num-ctx').value = src.num_ctx
  $('opt-max-iterations').value = src.maxIterations
  $('opt-max-iterations-val').textContent = src.maxIterations
  $('opt-grounding').checked = src.grounding
  const sel = $('opt-model')
  if (sel && src.model && sel.querySelector(`option[value="${src.model}"]`)) sel.value = src.model
}

// Anchored to #indicator-area now that the settings gear is gone — opened
// from the "⚙ Model & parameters" action in the indicator's dropdown instead.
function positionSettingsPanel() {
  const r = indicatorArea.getBoundingClientRect()
  const width = settingsPanel.getBoundingClientRect().width || 320
  settingsPanel.style.left = Math.max(8, r.right - width) + 'px'
  settingsPanel.style.top = (r.bottom + 6) + 'px'
}

function openSettingsPanel() {
  if (isSettingsOpen()) return
  settingsDraft = { ...modelOpts, maxIterations, grounding, model: selectedModel }
  syncSettingsUI()
  settingsPanel.classList.add('open')
  positionSettingsPanel()
}

// Closes without touching the committed state — shared by Cancel and any
// outside-click/Escape dismissal (see closeAllDropdowns()).
function cancelSettingsPanel() {
  settingsPanel.classList.remove('open')
  settingsDraft = null
}

function saveSettingsPanel() {
  if (settingsDraft) {
    modelOpts.temperature = settingsDraft.temperature
    modelOpts.top_p = settingsDraft.top_p
    modelOpts.top_k = settingsDraft.top_k
    modelOpts.num_ctx = settingsDraft.num_ctx
    maxIterations = settingsDraft.maxIterations
    grounding = settingsDraft.grounding
    if (settingsDraft.model && settingsDraft.model !== selectedModel) selectModel(settingsDraft.model)
  }
  settingsPanel.classList.remove('open')
  settingsDraft = null
}

$('opt-temperature').addEventListener('input', e => {
  if (!settingsDraft) return
  settingsDraft.temperature = parseFloat(e.target.value)
  $('opt-temperature-val').textContent = settingsDraft.temperature.toFixed(2)
})
$('opt-top-p').addEventListener('input', e => {
  if (!settingsDraft) return
  settingsDraft.top_p = parseFloat(e.target.value)
  $('opt-top-p-val').textContent = settingsDraft.top_p.toFixed(2)
})
$('opt-top-k').addEventListener('change', e => { if (settingsDraft) settingsDraft.top_k = parseInt(e.target.value, 10) })
$('opt-num-ctx').addEventListener('change', e => { if (settingsDraft) settingsDraft.num_ctx = parseInt(e.target.value, 10) })
$('opt-max-iterations').addEventListener('input', e => {
  if (!settingsDraft) return
  settingsDraft.maxIterations = parseInt(e.target.value, 10)
  $('opt-max-iterations-val').textContent = settingsDraft.maxIterations
})
$('opt-grounding').addEventListener('change', e => { if (settingsDraft) settingsDraft.grounding = e.target.checked })
// Reset restores the DRAFT to defaults (still requires Save to commit), so it
// composes with the same draft/Save/Cancel flow as every other control.
$('settings-reset').addEventListener('click', () => {
  if (!settingsDraft) return
  Object.assign(settingsDraft, DEFAULTS)
  settingsDraft.maxIterations = MAX_ITERATIONS_DEFAULT
  settingsDraft.grounding = true
  syncSettingsUI()
})
$('settings-cancel').addEventListener('click', cancelSettingsPanel)
$('settings-save').addEventListener('click', saveSettingsPanel)
// Clicks inside the dropdown shouldn't bubble to the document-level
// closeAllDropdowns() listener (same pattern as .nav-drop-attach).
settingsPanel.addEventListener('click', e => e.stopPropagation())
syncSettingsUI()

// ── Inline trace block (in chat) ──────────────────────────────────
// There is no longer a wrapping "Run log" DOM element (see startTraceBlock) —
// traceRunActive is the flag that replaces `!!currentTraceBlock` checks
// throughout the top-level (untagged-event) trace path.
let traceRunActive = false
let traceToolCalls = 0
let traceStartTime = null
// Latest iteration number of the current run.
let latestIteration = null
// True once any per-agent conclude card (renderAgentConclusion) has rendered
// during the CURRENT run — reset per run in startTraceBlock(). Every live run
// is a dispatch run (see startTraceBlock's comment), so this is set on every
// normal run; it exists so the harness's own untagged, top-level 'message'/
// 'done' — which restates the exact same final answer — doesn't ALSO render a
// redundant generic "Agent concluded" card on top of the per-agent ones. See
// renderConclusionCard.
let anyFrameConcludedThisRun = false

// ── Collapsed "current activity" pacing (retired) ────────────────
// This used to pace a one-line summary into the wrapping "Run log" block's
// collapsed subtitle. That block no longer exists (see startTraceBlock's
// comment) — each agent now has its own independent accordion, so there is
// no single collapsed line left to surface activity on. surfaceActivity/
// summarize are kept as no-ops/harmless helpers rather than ripped out of
// every call site, since each call site still marks a meaningful "something
// just happened" moment that a future single-line indicator could reuse.
function surfaceActivity(_text) { /* no-op — see comment above */ }
function clearActivityQueue() { /* no-op — see comment above */ }

// One line, no newlines — was for the collapsed activity subtitle only; the
// full text still goes into the expanded trace item body untouched. No
// longer called anywhere but kept for the same reason as surfaceActivity.
function summarize(text, max = 90) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

// Resets per-run trace state at the start of every run. There is no longer a
// wrapping "Run log" accordion here — every spawned agent gets its own
// standalone accordion (see getOrCreateRoleCard), rendered directly into
// #messagesEl, and the plain top-level (untagged-event) trace items render
// the same way (see addTopLevelTraceHtml/addTraceItem). This function still
// exists (rather than being called for its side effects) as the one place
// that clears state which must not leak from one run into the next.
function startTraceBlock(model) {
  traceToolCalls = 0
  traceStartTime = Date.now()
  latestIteration = null
  clearActivityQueue()
  // Multi-agent architecture (config.agents): each top-level run starts with a clean
  // slate of role cards — frameIds are unique per run, but nothing should ever look
  // up a PRIOR run's card by accident.
  roleCards.clear()
  // A held objective (or the frame it was waiting on) can never belong to a NEW
  // run — drop any stale state rather than risk it flushing against an unrelated
  // frameId later.
  pendingObjective = null
  activeDispatcherFrameId = null
  lastObjectiveText = ''
  lastConclusionKey = ''
  // Every live run goes through dispatch.ts's runDispatchLoop, which — on top of
  // every per-frame conclude card rendered via handleFrameEvent/renderAgentConclusion —
  // ALSO emits its own untagged, harness-level 'message'/'done' with the exact
  // same final answer, which would otherwise render its own generic "Agent
  // concluded" card. See renderConclusionCard below, which this flag makes a
  // no-op for the rest of the run once any per-agent conclude card has already
  // shown that same result.
  anyFrameConcludedThisRun = false
  // Marks a run as "in progress" for the top-level (untagged-event) trace path —
  // addTopLevelTraceHtml/addTraceItem/addIterationSeparator all check this rather
  // than a DOM element, since there's no wrapping block to hold one anymore.
  traceRunActive = true
}

// Ends the run's top-level trace state. No DOM to finalize (see startTraceBlock) —
// this just clears the activity queue and marks the run as no longer active.
function finalizeTraceBlock() {
  clearActivityQueue()
  traceRunActive = false
}

// Bold full-width divider marking a new iteration — a structural break in
// the trace, not another event row (no label/body chrome, no left edge to
// match). Rendered directly into #messagesEl, a sibling of the chat bubbles,
// role-card accordions and conclude cards around it — there is no wrapping
// "Run log" block to append into or to drive a collapsed title on anymore.
function addIterationSeparator(n) {
  latestIteration = n
  if (!traceRunActive) return null
  const el = document.createElement('div')
  el.className = 'trace-separator'
  el.innerHTML = `<span class="trace-separator-line"></span><span class="trace-separator-label">Iteration ${n}</span><span class="trace-separator-line"></span>`
  messagesEl.appendChild(el)
  maybeAutoScroll()
  return el
}

let busy = false
let currentRunModel = ''
const sendBoat = $('send-boat')
const sendStop = $('send-stop')

// Prompt queue (in-memory; lost on refresh). Items: { id, text }
const promptQueue = []
const originalPlaceholder = inputEl.placeholder

// ── SSE connection ───────────────────────────────────────────────
const es = new EventSource(`${API_BASE}/events`)

es.onopen = () => {
  if (!busy) setStatus('ready', 'Ready')  // don't clobber a running state on (re)connect
  // A reconnect can straddle a run's end/start while the connection was down, and any
  // `done`/run-start event that fired during the gap is simply lost (SSE replay only
  // covers this session's own persisted events, not a state transition). Reconcile
  // against the server's actual busy state — fire and forget so onopen stays synchronous.
  fetch(`${API_BASE}/status`).then(r => r.json()).then(status => {
    if (status.busy === false && busy) {
      setBusy(false)
      setStatus('ready', 'Ready')
    } else if (status.busy === true && !busy) {
      setBusy(true)
    }
  }).catch(() => { /* ignore — next onopen or the stop-poll safety net will retry */ })
}
es.onerror = () => setStatus('error', 'Disconnected — reload page')

es.onmessage = (e) => {
  const event = JSON.parse(e.data)
  // While replaying persisted events, buffer live events so they render after
  // the replay (in order, deduped) rather than interleaving with it.
  if (replaying) { pendingEvents.push(event); return }
  handleLiveEvent(event)
}

// A single live SSE event. Dedupes against already-replayed events of the
// current run via the per-run __seq high-water mark, then renders it through the
// live path.
function handleLiveEvent(event) {
  const seq = event.__seq
  // __seq is per-run, so seq === 1 marks the first event of a NEW run (the
  // user message, which precedes 'start') — reset the mark so the new run's
  // events aren't mistaken for already-seen ones from a longer previous run.
  if (seq === 1) liveRunMaxSeq = 0
  if (typeof seq === 'number') {
    if (seq <= liveRunMaxSeq) return   // already rendered (via replay or earlier)
    liveRunMaxSeq = seq
  }
  handleEvent(event)
}

// Replays persisted events for one or more runs (sorted by start time) through
// the replay render path, in file order — which is already correct order, since
// each run's JSONL is appended in emission order. Returns the __seq of the last
// event rendered, i.e. the current run's high-water mark for live dedup.
// Per-conversation sticky settings: restore the model + sampling options a
// session last used, derived from its most recent run's log meta (no separate
// storage — every run already records model + options). Called for every session
// switch via replaySessionRuns below, so switching between e.g. a Qwen
// conversation and a Mistral one keeps each one's model, temperature and context
// size. A session with no runs yet (fresh) leaves the current settings untouched.
function applySessionSettings(runs) {
  const ordered = (runs ?? []).slice().sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
  const run = ordered.reverse().find(r => r && r.model)
  if (!run) return
  selectModel(run.model)
  const o = run.options || {}
  modelOpts.temperature = o.temperature ?? DEFAULTS.temperature
  modelOpts.top_p       = o.top_p       ?? DEFAULTS.top_p
  modelOpts.top_k       = o.top_k       ?? DEFAULTS.top_k
  modelOpts.num_ctx     = o.num_ctx     ?? DEFAULTS.num_ctx
  syncSettingsUI()
}

async function replaySessionRuns(runs) {
  applySessionSettings(runs)
  let lastSeq = 0
  const ordered = (runs ?? []).slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  for (const run of ordered) {
    try {
      const resp = await fetch(`${API_BASE}/logs/${encodeURIComponent(run.filename)}`)
      if (!resp.ok) continue
      const data = await resp.json()
      for (const evt of (data.events ?? [])) {
        if (typeof evt.__seq === 'number') lastSeq = evt.__seq
        handleEventForSession(evt)
      }
    } catch { /* skip unreadable runs */ }
  }
  return lastSeq
}

// Ends a replay: stop buffering, then render everything that streamed in live
// during the replay, in order and deduped (via handleLiveEvent) against what was
// just replayed. This is the persisted-replay/SSE boundary — no gaps (buffered
// events are flushed) and no duplicates (the __seq high-water mark drops any that
// the replay already covered).
function finishReplay() {
  replaying = false
  const buffered = pendingEvents
  pendingEvents = []
  for (const ev of buffered) handleLiveEvent(ev)
}

function handleEvent(event) {
  // Multi-agent architecture: a tagged event belongs to one frame's
  // turn, not the top-level run — route it into that frame's role card instead of
  // the switch below. Also nudges the status bar to name the active role, the
  // "dispatcher-level" glance the multi-agent UI is built around.
  if (event.__frameId) {
    // token_usage is handled HERE, before the routing below, and deliberately not
    // inside handleFrameEvent: the harness's untagged, top-level path never emits
    // its own token_usage in multi-agent mode, so the donut would otherwise sit
    // frozen near-zero regardless of what the frames are actually doing. The
    // per-frame Agent instances are the only ones that ever call the model, so
    // the donut has to read straight off whichever frame's
    // token_usage just arrived. This does NOT skip the routing below — it falls
    // through to handleFrameEvent()/the early return exactly as before, which ALSO
    // uses this same event to annotate the frame's current iteration divider with
    // its response time (see annotateRoleCardIterationTiming).
    if (event.type === 'token_usage') updateCtx(event.prompt_tokens, event.num_ctx, event.__frameId, event.__role)
    handleFrameEvent(event)
    if (event.type === 'start') {
      const meta = ROLE_META[event.__role] || { title: event.__role }
      setStatus('busy', `Running · ${meta.title}`)
    }
    return
  }
  switch (event.type) {
    case 'start':
      currentRunModel = event.model
      startTraceBlock(event.model)
      setStatus('busy', `Running · ${event.model}`)
      break

    case 'objective':
      renderObjective(event)
      break

    case 'iteration':
      iterLabel.textContent = `${event.current}`
      addIterationSeparator(event.current)
      // Safety net: if compaction failed last iteration, only a 'warning' fires
      // (no 'compact'), so this is what clears "Compacting context…" from the
      // indicator/status bar.
      compactingNow = false
      setStatus('busy', `Running · ${currentRunModel}`)
      break

    case 'thought':
      renderThoughtItems(event, null)
      surfaceActivity(summarize(event.content || event.thinking))
      break

    case 'tool_call': {
      traceToolCalls++
      addTopLevelToolCall(event.tool, event.args)
      surfaceActivity(event.tool)
      break
    }

    case 'tool_result': {
      const isError = !!event.error
      const label = `Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addTraceItem(isError ? 'tool-result error' : 'tool-result', label, body, true)
      surfaceActivity(isError ? `${event.tool || 'tool'} failed` : `${event.tool || 'result'} received`)
      // Live-update the file tree + the viewed file when the agent may have changed files.
      if (!isError && (event.tool === 'write_file' || event.tool === 'edit_file' || event.tool === 'bash')) {
        scheduleWorkspaceRefresh()
      }
      break
    }

    case 'message':
      // The harness's own untagged, top-level assistant 'message' — rendered
      // as its own conclusion card (see renderConclusionCard), same family as
      // the per-frame cards below, rather than a plain chat bubble.
      if (event.role === 'assistant') {
        renderConclusionCard('Agent concluded', event.content)
      }
      break

    case 'token_usage':
      updateCtx(event.prompt_tokens, event.num_ctx)
      break

    case 'done': {
      // Capture the user-stop flag before setBusy(false) resets stopRequested.
      const wasStopped = stopRequested
      // Some harness builds carry the final answer directly on 'done' rather
      // than (or in addition to) a preceding 'message' — render it the same
      // way. renderConclusionCard()'s lastConclusionKey guard drops this call
      // as a no-op if the 'message' case above already rendered the exact
      // same content for this run, so a build that emits BOTH doesn't show
      // the same conclusion twice.
      if (event.content) renderConclusionCard('Agent concluded', event.content)
      setStatus('ready', 'Ready')
      finalizeTraceBlock()
      setBusy(false)
      iterLabel.textContent = ''
      refreshGitLog()
      if (filesMode === 'files') refreshFiles()
      else refreshChanges()
      // Browser notification on a clean finish (with the workspace name), when the tab is
      // not focused — so you learn a task completed while looking elsewhere.
      if (!wasStopped) {
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus()) {
            const ws = window.__WS__ || 'workspace'
            const q = currentSessionQuery ? ': ' + (currentSessionQuery.length > 60 ? currentSessionQuery.slice(0, 60) + '…' : currentSessionQuery) : ''
            new Notification('Argo · ' + ws, { body: 'Task complete' + q, icon: '/favicon.svg' })
          }
        } catch { /* notifications unavailable — ignore */ }
      }
      // Auto-advance the queue only on a clean finish (not on a user stop).
      if (!wasStopped && promptQueue.length) {
        const next = promptQueue.shift()
        renderQueue()
        startRun(next.text)
      } else {
        confirmRunEnded()
      }
      break
    }

    case 'compact':
      compactingNow = false
      if (compactStartTime) {
        lastCompactionDurationS = Math.round((Date.now() - compactStartTime) / 1000)
        compactStartTime = null
      }
      setStatus('busy', `Running · ${currentRunModel}`)
      addTraceItem('compact', `Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      surfaceActivity('Context compacted')
      break

    case 'warning':
      addTraceItem('warning', 'Warning', event.message, false)
      surfaceActivity(summarize(event.message))
      break

    case 'git_commit':
      addTraceItem('git', `Committed`, `${event.hash} — ${event.message}`, false)
      surfaceActivity('Committed')
      refreshGitLog()
      // The new commit + cleared working changes only matter to Changes mode.
      refreshChangesIfActive()
      break

    case 'error':
      addTraceItem('error-item', 'Error', event.message, false)
      compactingNow = false
      setStatus('error', 'Error')
      finalizeTraceBlock()
      setBusy(false)
      confirmRunEnded()
      break
  }
}

// Appends a pre-built HTML element directly into #messagesEl — the top-level
// equivalent of addRoleCardHtml, used for formatted tool calls and
// thinking/content blocks outside any per-frame section. There is no wrapping
// "Run log" block to append into anymore (see startTraceBlock's comment); this
// still gates on traceRunActive so nothing renders once a run has ended.
function addTopLevelTraceHtml(el) {
  if (!traceRunActive || !el) return
  messagesEl.appendChild(el)
  maybeAutoScroll()
}

function addTopLevelToolCall(tool, args) {
  const wrap = document.createElement('div')
  wrap.innerHTML = formatToolCall(tool, args)
  wireToolCallExpanders(wrap)
  addTopLevelTraceHtml(wrap.firstElementChild)
}

// Renders one PERSISTED (replayed) event into the trace/chat. Reuses the same
// DOM helpers as the live path for identical visual output, but omits every
// live-only side effect (status bar, busy state, git/file refreshes, the
// top-level iteration/token counters — those reflect a *running* agent, not
// history). Unlike the live path it also renders user messages: on replay
// there is no submit handler to have added them optimistically. A tagged
// event still goes through the shared handleFrameEvent() below exactly like
// the live path, so a replayed run's role-card accordions show the same
// per-iteration dividers and response timings (from 'iteration'/'token_usage')
// as they did live — only the untagged top-level 'iteration' case (further
// down) skips the live-only iterLabel/status-bar update. Untagged
// ollama_request has no role-card representation either way.
function handleEventForSession(event) {
  if (event.__frameId) {
    handleFrameEvent(event)
    return
  }
  switch (event.type) {
    case 'start':
      startTraceBlock(event.model)
      break

    case 'objective':
      renderObjective(event)
      break

    case 'iteration':
      addIterationSeparator(event.current)
      break

    case 'thought':
      renderThoughtItems(event, null)
      break

    case 'tool_call': {
      traceToolCalls++
      addTopLevelToolCall(event.tool, event.args)
      break
    }

    case 'tool_result': {
      const isError = !!event.error
      const label = `Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addTraceItem(isError ? 'tool-result error' : 'tool-result', label, body, true)
      break
    }

    case 'message':
      // Only a genuine USER message is a plain chat bubble on replay — the
      // harness's own top-level final answer renders as a conclusion card
      // (see the live path in handleEvent for why), same on replay for
      // identical visual output.
      if (event.role === 'assistant') renderConclusionCard('Agent concluded', event.content)
      else addChatMessage(event.role, event.content)
      break

    case 'compact':
      addTraceItem('compact', `Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      break

    case 'warning':
      addTraceItem('warning', 'Warning', event.message, false)
      break

    case 'git_commit':
      addTraceItem('git', `Committed`, `${event.hash} — ${event.message}`, false)
      break

    case 'done':
      if (event.content) renderConclusionCard('Agent concluded', event.content)
      finalizeTraceBlock()
      break

    case 'error':
      addTraceItem('error-item', 'Error', event.message, false)
      finalizeTraceBlock()
      break
  }
}

// ── UI helpers ───────────────────────────────────────────────────
// Drives BOTH the legacy (now hidden) #status dot/text and the combined
// indicator: state is 'ready' | 'busy' | 'error'; compactingNow (module state,
// set/cleared around the 'compact' event) overrides to 'compacting' regardless
// of what's passed here, since a compaction can occur either mid-run or
// standalone between runs.
function setStatus(state, text) {
  statusDot.className = state === 'ready' ? '' : state
  statusText.textContent = text
  indicatorState = compactingNow ? 'compacting' : state
  renderDonut()
  // Keep an open dropdown's status/context rows live rather than stale text.
  if (navCtx.classList.contains('open')) buildCtxDropdown()
}

// The outermost layer (m1) always does the sail-past traverse. Each run randomly composes
// 1-3 DISTINCT rock motions from ROCK_MOTIONS onto the nested m2/m3/m4 layers — multiple CSS
// animations on the SAME element would just overwrite each other's `transform`, so each
// chosen motion gets its own layer so their rotations COMPOSE. Both which motions are picked
// and their order (which layer holds which) vary every time. Cleared when off.
const ROCK_MOTIONS = ['roll', 'yaw', 'pitch1', 'pitch2', 'pitch3']
const ROCK_LAYER_SELECTORS = ['.m2', '.m3', '.m4']

function pickRockMotions() {
  const count = 1 + Math.floor(Math.random() * 3)   // 1-3, inclusive
  const pool = [...ROCK_MOTIONS]
  const picked = []
  for (let i = 0; i < count && pool.length; i++) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return picked
}

function setSailing(on) {
  const m1 = sendBoat.querySelector('.m1')
  const layers = ROCK_LAYER_SELECTORS.map(sel => sendBoat.querySelector(sel))
  if (!m1 || layers.some(l => !l)) return
  m1.classList.remove('a-sail')
  for (const layer of layers) {
    for (const motion of ROCK_MOTIONS) layer.classList.remove('a-' + motion)
  }
  if (!on) return
  m1.classList.add('a-sail')
  pickRockMotions().forEach((motion, i) => layers[i].classList.add('a-' + motion))
}

// ── Depart transition ────────────────────────────────────────────
// On run start the boat doesn't jump straight into the sailing loop: it first departs
// one-shot to the right (`.departing`, ~450ms, see styles.css), and only once that's
// finished does the looping sail+rock animation begin (re-entering from the left via
// the existing sailthrough keyframe). departTimer/departHandler track the in-flight
// transition so a second submit or a run ending mid-depart can cancel it cleanly instead
// of stacking timeouts/listeners or leaving the boat stuck off-screen.
let departTimer = null
let departHandler = null

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function clearDepart() {
  if (departTimer !== null) {
    clearTimeout(departTimer)
    departTimer = null
  }
  if (departHandler) {
    sendBoat.removeEventListener('animationend', departHandler)
    departHandler = null
  }
  sendBoat.classList.remove('departing')
}

function beginDepart() {
  // Always clear any prior in-flight depart first so rapid re-submits can't stack
  // listeners/timeouts or leave leftover classes.
  clearDepart()
  if (prefersReducedMotion()) {
    setSailing(true)
    return
  }
  sendBoat.classList.add('departing')
  const finish = () => {
    clearDepart()
    // Only start the loop if the run is still active — it may have ended while the
    // boat was departing.
    if (busy) setSailing(true)
  }
  departHandler = (e) => {
    if (e.target !== sendBoat) return
    finish()
  }
  sendBoat.addEventListener('animationend', departHandler)
  // Matches the ~450ms depart animation duration as a fallback in case animationend
  // doesn't fire (e.g. the element was hidden mid-transition).
  departTimer = setTimeout(finish, 480)
}

function setBusy(val) {
  busy = val
  // Leave the textarea enabled while the agent runs so the user can queue prompts.
  inputEl.placeholder = val ? 'Queue a prompt… (Enter to queue)' : originalPlaceholder

  if (val) {
    // The boat stays visible: it first departs to the right (beginDepart), and only once
    // that one-shot transition finishes does it start sailing — setSailing randomly
    // composes 1-3 rock motions (roll/yaw/pitch variants) across the nested layers so their
    // transforms cumulate. Hovering the button swaps the boat for the stop square (hover
    // handlers).
    sendBoat.classList.remove('hidden')
    sendStop.classList.add('hidden')
    beginDepart()
    sendBtn.title = 'Stop'
  } else {
    // Cancel any in-flight depart transition so the boat doesn't get stuck off-screen or
    // start the sailing loop after the run has already ended.
    clearDepart()
    setSailing(false)
    sendBoat.classList.remove('hidden')
    sendStop.classList.add('hidden')
    sendBtn.title = 'Send'
    stopRequested = false
  }
}

let stopRequested = false

// Defensive safety net for the top-level 'done'/'error' SSE events themselves —
// mirrors stopAgent's own poll below. setBusy(false) in handleEvent is optimistic:
// it trusts the SSE event just received. server.ts sets its own isBusy=false in a
// finally block AFTER dispatch.ts's 'done'/'error' emission and its logger.flush()
// — a normally-brief window where a concurrent /status call still reports
// busy:true. Give that flush a couple of seconds head start, then confirm the
// server actually agrees the run is over. If /status still says busy after that,
// this isn't the harmless race — something is genuinely stuck server-side (or the
// SSE event that just fired was itself stale/misrouted) — and the UI should say so
// instead of quietly sitting on "Ready" while the server disagrees.
async function confirmRunEnded() {
  await new Promise(resolve => setTimeout(resolve, 2500))
  if (busy) return  // a new run already started (e.g. queue auto-advance) — nothing to confirm
  let status
  try {
    status = await fetch(`${API_BASE}/status`).then(r => r.json())
  } catch {
    return  // network hiccup — not worth flagging as a server-side problem
  }
  if (status.busy === true) {
    setBusy(true)
    setStatus('error', 'Server still reports busy after the run ended — reload if this persists')
  }
}

async function stopAgent() {
  // Abort only takes effect once the current model/tool call finishes, which can
  // take a while — without this the click looks like it did nothing in the meantime.
  stopRequested = true
  setStatus('busy', 'Stopping…')
  try { await fetch(`${API_BASE}/stop`, { method: 'POST' }) } catch { /* ignore */ }

  // Safety net: the normal path is the `done` SSE event calling setBusy(false). If it's
  // delayed, dropped, or the stream hiccups right after a stop, the boat is stuck sailing
  // forever with no recovery but a refresh. Poll /status a few times, giving `done` a head
  // start each round before asking the server directly.
  for (let attempt = 0; attempt < 3 && busy; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (!busy) return  // `done` arrived while we were waiting — nothing left to do
    let status
    try {
      status = await fetch(`${API_BASE}/status`).then(r => r.json())
    } catch {
      continue  // network hiccup — just try again next round
    }
    if (status.busy === false) {
      setBusy(false)
      setStatus('ready', 'Ready')
      return
    }
  }
  // Still busy after 3 rounds (~6s) with the server agreeing it's busy: this isn't a lost
  // event, something is actually stuck server-side. Surface it instead of spinning forever.
  if (busy) setStatus('error', 'Stop failed — agent still busy')
}

// ── Combined indicator dropdown ───────────────────────────────────
// Clicking the indicator opens a dropdown with a non-clickable 2-line status
// readout (status+model / precise context numbers) on top, then three
// clickable actions: "⚙ Model & parameters" (opens the settings panel, which
// used to be opened by the now-removed gear button), "🔍 View context" (opens
// the context viewer), and "↺ Clear conversation" (replaces the old
// standalone new-session button). Reuses the .nav-crumb / .nav-dropdown
// pattern, so closeAllDropdowns() (outside-click + Escape) closes it for
// free.
const navCtx = $('nav-ctx')
const ctxDropdown = $('ctx-dropdown')

function compactStatusText() {
  if (indicatorState === 'compacting') {
    return lastCompactionDurationS ? `Compacting… (~${lastCompactionDurationS}s)` : 'Compacting…'
  }
  if (indicatorState === 'error') return 'Error'
  const model = selectedModel || '—'
  return indicatorState === 'busy' ? `Running · ${model}` : `Ready · ${model}`
}

function buildCtxDropdown() {
  ctxDropdown.innerHTML = ''

  // Non-clickable 2-line status readout — plain info, not an action.
  const head = document.createElement('div')
  head.className = 'ctx-status-head'
  const line1 = document.createElement('div')
  line1.className = 'ctx-status-line1'
  line1.textContent = compactStatusText()
  head.appendChild(line1)
  if (ctxState.numCtx) {
    const line2 = document.createElement('div')
    line2.className = 'ctx-status-line2'
    // A frame-owned reading (multi-agent mode) is prefixed with WHOSE context this
    // is, so a number never appears without an owner — see the token_usage handling
    // in handleEvent(). An untagged reading (ctxState.role === null) keeps the
    // original precise format unchanged.
    line2.textContent = ctxState.role
      ? `${(ROLE_META[ctxState.role] || { title: ctxState.role }).title} · ${fmtTokensK(ctxState.promptTokens)} / ${fmtTokensK(ctxState.numCtx)} (${ctxState.pct}%)`
      : `${ctxState.promptTokens.toLocaleString()} / ${ctxState.numCtx.toLocaleString()} tokens · ${ctxState.pct}%`
    head.appendChild(line2)
  } else {
    const line2 = document.createElement('div')
    line2.className = 'ctx-status-line2 muted'
    line2.textContent = 'No context yet'
    head.appendChild(line2)
  }
  ctxDropdown.appendChild(head)

  const sep = document.createElement('div')
  sep.className = 'nav-drop-sep'
  ctxDropdown.appendChild(sep)

  // Action 1 — model & parameters. Opens the LLM settings panel (formerly
  // opened by the standalone gear button, now removed).
  const settingsRow = document.createElement('div')
  settingsRow.className = 'nav-drop-item'
  settingsRow.innerHTML = `<span>⚙ Model &amp; parameters</span>`
  settingsRow.addEventListener('click', (e) => {
    // Without this, the click bubbles up to the document-level
    // closeAllDropdowns() listener AFTER openSettingsPanel() has already run
    // (both fire during the same bubble phase) — closeAllDropdowns() sees the
    // panel is open and immediately cancels it via cancelSettingsPanel(), so
    // the panel flashed open and shut in the same click. Stopping propagation
    // here (same pattern as settingsPanel's own click handler) is the fix.
    e.stopPropagation()
    navCtx.classList.remove('open')
    openSettingsPanel()
  })
  ctxDropdown.appendChild(settingsRow)

  // Action 2 — view context. Opens the context viewer.
  const ctxRow = document.createElement('div')
  ctxRow.className = 'nav-drop-item'
  ctxRow.innerHTML = `<span>🔍 View context</span>`
  ctxRow.addEventListener('click', () => {
    navCtx.classList.remove('open')
    viewContext()
  })
  ctxDropdown.appendChild(ctxRow)

  // Action 3 — clear conversation (was the standalone "＋" button in the breadcrumb;
  // now uses a reset-style "↺" glyph, which reads as clearing/restarting rather
  // than adding).
  const clearDisabled = busy
  const clearRow = document.createElement('div')
  clearRow.className = `nav-drop-item${clearDisabled ? ' disabled' : ''}`
  clearRow.innerHTML = `<span>↺ Clear conversation</span>${clearDisabled ? '<span class="ctx-hint">running…</span>' : ''}`
  if (!clearDisabled) {
    clearRow.addEventListener('click', () => {
      navCtx.classList.remove('open')
      newSession()
    })
  }
  ctxDropdown.appendChild(clearRow)
}

tokenCounter.addEventListener('click', (e) => {
  e.stopPropagation()
  const wasOpen = navCtx.classList.contains('open')
  closeAllDropdowns()
  if (!wasOpen) {
    buildCtxDropdown()
    navCtx.classList.add('open')
    const r = tokenCounter.getBoundingClientRect()
    // The indicator now lives at the top of the viewport, so there's always
    // room below it — always open downward (no upward fallback needed).
    ctxDropdown.style.left = Math.max(8, r.right - 260) + 'px'
    ctxDropdown.style.bottom = 'auto'
    ctxDropdown.style.top = (r.bottom + 6) + 'px'
  }
})

// ── Frame-aware context viewer ──────────────────────────────────────
// GET /frames lists every frame of the current session (see CONTEXT-VIEWER-CONTRACT.md);
// GET /context?frame=<id> loads one of them, GET /context with no param loads the
// harness's own untagged, top-level context. /frames is the newer of the two routes,
// so it may 404 if this half of the feature isn't deployed yet on the running server;
// ctxFramesData stays null in that case and the viewer falls back to the single-context
// view it always had.
let ctxFramesData = null       // last /frames response, or null when the route is unavailable
let ctxSelectedFrame = null    // frameId currently shown in #diff-content, or null for the untagged context

// Fetches JSON defensively: an unreachable/not-yet-deployed route can 404 with an HTML
// "Cannot GET …" body, and parsing that as JSON is exactly the
// `Unexpected token '<', "<!DOCTYPE"` failure this guards against — treat anything that
// isn't a successful, actually-JSON response as absent rather than letting it throw.
async function fetchJson(url) {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const ct = resp.headers.get('content-type') || ''
    if (!ct.includes('application/json')) return null
    return await resp.json()
  } catch {
    return null
  }
}

// Default selection per the contract: the frame currently running, else the largest by
// totalChars (the one actually worth reading) — falling back to the untagged context
// when there are no frames at all yet (a fresh session, or agents mode simply off).
function pickDefaultFrame(framesData) {
  if (framesData.active) return framesData.active
  const frames = framesData.frames || []
  if (!frames.length) return null
  // Default to the frame with the most content (likely the most interesting)
  let best = frames[0]
  for (const f of frames) if ((f.totalChars ?? 0) > (best.totalChars ?? 0)) best = f
  return best.frameId
}

// Reuses ROLE_META (the same names the role sections use) rather than inventing a
// second vocabulary for the same four roles.
function frameOptionLabel(f) {
  const meta = ROLE_META[f.role] || { title: f.role }
  return `${meta.title} (${f.frameId}) · ${(f.totalChars ?? 0).toLocaleString()} chars${f.live ? ' · live' : ''}`
}

// Rebuilds the selector from ctxFramesData — or, when it's null (no /frames route),
// drops the select entirely and shows a plain explanatory line instead.
function renderCtxFrameBar() {
  ctxFrameBar.classList.remove('hidden')
  if (!ctxFramesData) {
    ctxFrameBar.classList.add('note-only')
    ctxFrameHint.textContent = 'Per-frame inspection needs a server restart — showing the top-level context only.'
    return
  }
  ctxFrameBar.classList.remove('note-only')
  ctxFrameHint.textContent = ''
  ctxFrameSelect.innerHTML = ''
  for (const f of ctxFramesData.frames || []) {
    const opt = document.createElement('option')
    opt.value = f.frameId
    opt.textContent = frameOptionLabel(f)
    ctxFrameSelect.appendChild(opt)
  }
  ctxFrameSelect.value = ctxSelectedFrame ?? ''
}

// Loads one frame's context (or the untagged, top-level context, when frameId is null)
// into the already-open modal. Shared by viewContext() (initial load) and the
// selector's change handler.
async function loadFrameContext(frameId) {
  ctxSelectedFrame = frameId
  if (ctxFramesData) ctxFrameSelect.value = frameId ?? ''
  diffContent.textContent = 'Loading…'
  const qs = frameId ? `?frame=${encodeURIComponent(frameId)}` : ''
  const data = await fetchJson(`${API_BASE}/context${qs}`)
  if (!data) {
    diffContent.textContent = 'Failed to load context.'
    showToast('Failed to load context')
    return
  }
  // Title names the owner (never a bare, unattributed count).
  const meta = ROLE_META[data.role] || { title: data.role || 'Agent' }
  const owner = meta.title
  diffTitle.textContent = `${owner} — Context (${data.messageCount ?? 0} messages · ${(data.totalChars ?? 0).toLocaleString()} chars · num_ctx ${(data.numCtx ?? 0).toLocaleString()})`
  diffContent.innerHTML = renderContext(data)
}

ctxFrameSelect.addEventListener('change', () => {
  loadFrameContext(ctxFrameSelect.value || null)
})

// View the exact context the model currently sees. Read-only; reuses #diff-modal.
async function viewContext() {
  diffTitle.textContent = 'Context'
  diffContent.textContent = 'Loading…'
  ctxFrameBar.classList.add('hidden')
  diffModal.classList.add('open')

  // /frames is the newer of the two routes and may not be deployed yet (see
  // fetchJson) — that is an expected, quiet fallback, not an error toast.
  ctxFramesData = await fetchJson(`${API_BASE}/frames`)
  renderCtxFrameBar()
  const defaultFrame = ctxFramesData ? pickDefaultFrame(ctxFramesData) : null
  await loadFrameContext(defaultFrame)
}

function renderContext(data) {
  let html = ''
  // Right-aligned wall-clock time (when the message entered the model context, from the
  // backend WeakMap via getContext). Omitted when unknown (e.g. messages restored from disk).
  const timeTag = (ts) => ts != null ? `<span class="ctx-time">${escHtml(new Date(ts).toLocaleTimeString())}</span>` : ''
  for (const m of (data.messages ?? [])) {
    const role = String(m.role ?? '')
    html += `<div class="ctx-msg"><div class="ctx-role ctx-role-${escHtml(role)}"><span>${escHtml(role)} · ${(m.chars ?? 0).toLocaleString()} chars</span>${timeTag(m.ts)}</div><div class="ctx-content">${escHtml(m.content ?? '')}</div></div>`
  }
  return html || '<div class="ctx-msg"><div class="ctx-content">(empty context)</div></div>'
}

// Stop click: intercept button click when busy to cancel instead of submit
sendBtn.addEventListener('click', (e) => {
  if (!busy) return
  e.preventDefault()
  if (stopRequested) return
  stopAgent()
})

// While a run is active the boat is sailing; hovering the button reveals the stop
// square so click-to-stop stays discoverable, then restores the sailing boat on leave.
sendBtn.addEventListener('mouseenter', () => {
  if (!busy) return
  sendBoat.classList.add('hidden')
  sendStop.classList.remove('hidden')
})
sendBtn.addEventListener('mouseleave', () => {
  if (!busy) return
  sendBoat.classList.remove('hidden')
  sendStop.classList.add('hidden')
})

// `container` defaults to #messagesEl itself (the top-level, untagged-event
// trace has no wrapping block to hold its own item list anymore — see
// startTraceBlock's comment), but a role card (see below) passes its OWN
// nested items list so the same rendering logic (label/body/expand-on-long-text)
// works identically whether an event belongs to the top-level run or to one
// specific agent's turn inside it.
function addTraceItem(className, label, body, collapsible, container) {
  const target = container || (traceRunActive ? messagesEl : null)
  if (!target) return null
  const el = document.createElement('div')
  el.className = `trace-item ${className}`

  if (label) {
    const labelEl = document.createElement('div')
    labelEl.className = 'trace-label'
    labelEl.textContent = label
    el.appendChild(labelEl)
  }

  const bodyEl = document.createElement('div')
  bodyEl.className = 'trace-body'

  const isLong = body && body.length > 300
  if (collapsible && isLong) {
    bodyEl.className += ' collapsed'
    bodyEl.textContent = body

    const btn = document.createElement('button')
    btn.className = 'expand-btn'
    btn.textContent = '▼ Show all'
    let expanded = false
    btn.onclick = () => {
      expanded = !expanded
      bodyEl.classList.toggle('collapsed', !expanded)
      btn.textContent = expanded ? '▲ Collapse' : '▼ Show all'
    }
    el.appendChild(bodyEl)
    el.appendChild(btn)
  } else {
    bodyEl.textContent = body ?? ''
    el.appendChild(bodyEl)
  }

  target.appendChild(el)
  maybeAutoScroll()
  return el
}

// ── Multi-agent architecture (config.agents) — per-agent accordions ──────────────
// Every event a spawned frame produces (thought/tool_call/plan/done/...) arrives
// tagged with __frameId/__role/__parentFrameId (see types.ts's FrameTag); an
// untagged event is the top-level dispatch narrative, rendered by the plain top-level
// code path (unchanged code path below). A tagged event instead goes into its OWN
// standalone collapsible accordion for that one frame's turn — a
// direct sibling of chat bubbles/conclude cards in #messagesEl's flat chronological
// flow, since dispatch is strictly sequential (docs/subagents-plan.md's hard
// no-parallelism rule), so execution order alone already shows which agent ran
// after which. Each accordion is followed immediately by that frame's own conclude
// card (see renderAgentConclusion) once it closes.
//
// Display names are a presentation-only layer over the plain functional role —
// see frames.ts's ROLE_NAME for the same mapping, chosen for an actual functional
// match rather than flavor alone.
const ROLE_META = {
  dispatcher:  { name: 'Dispatcher',  title: 'Dispatcher Agent' },
  planner:     { name: 'Planner',     title: 'Planner Agent' },
  implementer: { name: 'Implementer', title: 'Implementer Agent' },
}

// frameId -> { el, arrow, items, role, status }. Cleared per top-level
// run (startTraceBlock) — see there for why stale entries can't leak across runs.
// Unlike the old single "Run log" trace-block, each frame's record now owns its
// OWN standalone accordion element, appended directly into #messagesEl rather
// than nested inside any shared container — see getOrCreateRoleCard below.
const roleCards = new Map()

// Held 'objective' event awaiting the Dispatcher frame's card to close (see
// renderObjective/flushPendingObjectiveIfReady below), plus which frame it's
// waiting on.
let pendingObjective = null
let activeDispatcherFrameId = null
// The most recent objective text seen this run — see stripDuplicatedObjective()
// below, which uses it to drop a conclusion's verbatim-restated objective.
let lastObjectiveText = ''

// Gets the section for an already-known frameId (a RESUMED frame — the Planner's next
// detail call reuses its existing section rather than creating a confusing duplicate),
// or creates a fresh one. Each agent's turn gets its OWN collapsible accordion,
// rendered directly in #messagesEl (a sibling of chat bubbles/conclude cards) — not
// nested inside any shared "Run log" block, and not inside another agent's accordion
// either. Defaults to COLLAPSED: the conclude card rendered right after it (see
// renderAgentConclusion) is the at-a-glance summary; the accordion itself is the
// opt-in detail. `assignment` (the frame's originating query/request) is deliberately
// NOT rendered here — it's already shown as the user's chat message, and isn't
// readable in this compact form.
function getOrCreateRoleCard(frameId, role, assignment) {
  const existing = roleCards.get(frameId)
  if (existing) {
    existing.el.classList.add('active')
    return existing
  }
  const meta = ROLE_META[role] || { name: role, title: role }
  if (role === 'dispatcher') activeDispatcherFrameId = frameId

  const card = document.createElement('div')
  card.className = 'role-card active'

  const toggle = document.createElement('div')
  toggle.className = 'role-card-toggle'

  const arrow = document.createElement('span')
  arrow.className = 'role-card-arrow'
  arrow.textContent = '▶'

  const heading = document.createElement('h3')
  heading.className = 'agent-heading'
  heading.textContent = meta.title
  heading.style.color = AGENT_COLORS[role] || 'var(--text)'

  // No outcome/status element here — the conclude card rendered right after this
  // accordion (see renderAgentConclusion) already carries the status badge and
  // result; a second copy on the accordion's own toggle row would just duplicate it.
  toggle.append(arrow, heading)
  toggle.addEventListener('click', () => {
    card.classList.toggle('open')
    arrow.textContent = card.classList.contains('open') ? '▼' : '▶'
  })

  const items = document.createElement('div')
  items.className = 'role-card-items'

  // Collapsed by default (per-agent accordion, not always-expanded) — the
  // conclude card that follows carries the at-a-glance result.
  card.append(toggle, items)
  messagesEl.appendChild(card)
  maybeAutoScroll()

  // iterations/startTime/lastOllamaMs track this frame's own progress for the
  // iteration-counter/timing annotations (see handleFrameEvent's 'iteration'/
  // 'token_usage' cases) and the conclude card's "N iterations · Ts" meta line
  // (see renderAgentConclusion).
  const record = { el: card, arrow, items, role, status: null, iterations: 0, startTime: Date.now(), lastOllamaMs: null }
  roleCards.set(frameId, record)
  return record
}

function addRoleCardItem(frameId, className, label, body, collapsible) {
  const card = roleCards.get(frameId)
  if (!card) return
  addTraceItem(className, label, body, collapsible, card.items)
}

// Per-frame iteration divider — the role-card counterpart to the top-level
// addIterationSeparator(). Rendered INSIDE the accordion's own items list
// (unlike the top-level one, which has no card to nest inside) so a
// multi-agent run's trace still shows "which iteration is this" per agent.
// Stashes the element on the card record (as `lastIterEl`) so a following
// 'token_usage' event — which carries the response's timing but has no
// separator of its own — can annotate THIS most recent divider with it
// once it arrives (see the 'token_usage' case in handleFrameEvent).
function addRoleCardIterationSeparator(frameId, n) {
  const card = roleCards.get(frameId)
  if (!card) return null
  card.iterations = n
  // Stop any previous iteration's live timer before starting a new one
  if (card.iterTimerId) { clearInterval(card.iterTimerId); card.iterTimerId = null }
  const el = document.createElement('div')
  el.className = 'trace-separator'
  el.innerHTML = `<span class="trace-separator-line"></span><span class="trace-separator-label">Iteration ${n}</span><span class="trace-separator-line"></span>`
  card.items.appendChild(el)
  card.lastIterEl = el
  // Start a live elapsed-time counter that ticks until token_usage arrives
  const startTime = Date.now()
  const label = el.querySelector('.trace-separator-label')
  card.iterTimerId = setInterval(() => {
    if (!label) return
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    label.textContent = `Iteration ${n} (${elapsed}s…)`
  }, 1000)
  maybeAutoScroll()
  return el
}

// Replaces the live elapsed counter with the actual response time once known.
// The divider renders immediately on 'iteration' with a ticking counter; the
// 'token_usage' event carries the real timing and stops the timer.
function annotateRoleCardIterationTiming(frameId, ms) {
  const card = roleCards.get(frameId)
  if (!card) return
  card.lastOllamaMs = ms
  // Stop the live counter
  if (card.iterTimerId) { clearInterval(card.iterTimerId); card.iterTimerId = null }
  const el = card.lastIterEl
  if (!el) return
  const label = el.querySelector('.trace-separator-label')
  if (!label) return
  const base = label.textContent.replace(/\s*\([^)]*\)$/, '')
  label.textContent = `${base} (${fmtDuration(ms)})`
}

// Appends a pre-built HTML element (used for formatted tool calls / thinking /
// content blocks) directly into a frame's section, in order alongside the plain
// trace items added via addRoleCardItem.
function addRoleCardHtml(frameId, el) {
  const card = roleCards.get(frameId)
  if (!card || !el) return
  card.items.appendChild(el)
  maybeAutoScroll()
}

// Closes out a frame's accordion — no outcome/status text of its own to set
// (see getOrCreateRoleCard: the conclude card rendered right after the
// accordion, via renderAgentConclusion, is the one place that result shows).
// Does NOT flush a held objective — see closeRoleCard below, the normal entry
// point, which does; the 'done' case in handleFrameEvent uses this quiet
// variant instead so it can render the conclude card in between (objective
// card must land AFTER it, never before).
function closeRoleCardQuiet(frameId) {
  const card = roleCards.get(frameId)
  if (!card) return
  if (card.iterTimerId) { clearInterval(card.iterTimerId); card.iterTimerId = null }
  card.el.classList.remove('active')
}

// Normal entry point: closes the accordion AND immediately flushes a held
// objective once its Dispatcher frame has finished. Used by the 'error' path,
// which has no conclude card of its own to sequence the flush after.
function closeRoleCard(frameId) {
  closeRoleCardQuiet(frameId)
  flushPendingObjectiveIfReady(frameId)
}

// ── Per-tool formatted call display ──────────────────────────────
// A tool call's own content (a bash script, a write_file body, an edit's
// old/new blocks, a long conclude message) can run many lines — heredocs,
// pipelines, Playwright scripts, whole-file rewrites. Long tool RESULTS
// already collapse (see addTraceItem's `collapsible` param); this gives
// tool CALLS the same treatment. Building raw HTML strings here (rather than
// DOM elements, like addTraceItem) rules out addTraceItem's `.onclick =`
// approach — wireToolCallExpanders() below attaches the toggle listeners
// once, after the string is parsed into real DOM by the caller.
const TOOL_CALL_COLLAPSE_LINES = 4

// Renders one code/text block as either a plain <pre><code> (short content)
// or a collapsed one with a "▼ Show more" toggle (content past
// TOOL_CALL_COLLAPSE_LINES lines) — the tool-call counterpart of
// addTraceItem's collapsible .trace-body. Collapsed by default: unlike a
// 'thought' (the substance of a turn, shown expanded), a multi-line script or
// file body is the kind of thing worth a glance-and-skip most of the time.
// `heading` (optional) labels a block within a tool call that has more than
// one (e.g. edit_file's "Old"/"New") — omitted for a single-block tool call.
// `extraClass` (optional) adds a caller-specific class to the collapsed <pre>
// (e.g. conclude's "conclude-message-code") without post-hoc string surgery.
function collapsibleCodeHtml(text, heading, extraClass) {
  const str = String(text ?? '')
  const lines = str.split('\n')
  const headingHtml = heading ? `<div class="tool-call-block-label">${escHtml(heading)}</div>` : ''
  if (lines.length <= TOOL_CALL_COLLAPSE_LINES) {
    return `${headingHtml}<pre><code>${escHtml(str)}</code></pre>`
  }
  const preview = lines.slice(0, 3).join('\n')
  const preClass = extraClass ? `tool-call-code collapsed ${extraClass}` : 'tool-call-code collapsed'
  // Both the collapsed preview and the full text are pre-rendered into the DOM
  // (not re-rendered on toggle) — the toggle just swaps which <code> is
  // visible, same "cheap, no re-render" approach as .thinking-body/.trace-body.
  return `${headingHtml}`
    + `<pre class="${preClass}"><code class="tcc-preview">${escHtml(preview)}</code><code class="tcc-full">${escHtml(str)}</code></pre>`
    + `<button type="button" class="expand-btn tool-call-expand">▼ Show more (${lines.length} lines)</button>`
}

// Wires up every collapsed code block's toggle inside a just-inserted tool-call
// element. Call sites build the HTML via formatToolCall() then set it via
// innerHTML (so the browser parses it into real elements first) — this attaches
// the actual click behavior afterward, same two-step as renderThoughtItems
// would need if it built strings instead of elements.
function wireToolCallExpanders(root) {
  if (!root || !root.querySelectorAll) return
  root.querySelectorAll('.tool-call-expand').forEach(btn => {
    const pre = btn.previousElementSibling
    if (!pre || !pre.classList.contains('tool-call-code')) return
    const lineMatch = btn.textContent.match(/\((\d+) lines\)/)
    const lineCount = lineMatch ? lineMatch[1] : ''
    let expanded = false
    btn.addEventListener('click', () => {
      expanded = !expanded
      pre.classList.toggle('collapsed', !expanded)
      btn.textContent = expanded ? '▲ Collapse' : `▼ Show more (${lineCount} lines)`
    })
  })
}

// Replaces the old raw JSON.stringify(event.args, null, 2) dump with a small,
// tool-specific rendering. Returns an HTML string (caller wraps it in whatever
// container is appropriate — a role-card item or a top-level trace item) —
// callers MUST run the result through wireToolCallExpanders() once inserted,
// so any collapsible block built by collapsibleCodeHtml() above actually toggles.
function formatToolCall(tool, args) {
  args = args || {}
  switch (tool) {
    case 'bash': {
      const cmd = args.command ?? args.cmd ?? ''
      return `<div class="tool-call"><strong>Bash</strong>${collapsibleCodeHtml(cmd)}</div>`
    }
    case 'read_file': {
      const path = args.path ?? ''
      const hasRange = args.offset != null || args.limit != null
      const start = args.offset ?? 1
      const end = args.limit != null ? (Number(start) + Number(args.limit) - 1) : null
      const range = hasRange ? ` (lines ${start}${end != null ? '-' + end : '+'})` : ''
      return `<div class="tool-call"><strong>Read file</strong> <code>${escHtml(String(path))}</code>${range}</div>`
    }
    case 'write_file': {
      const path = args.path ?? ''
      const content = args.content ?? ''
      return `<div class="tool-call"><strong>Write file</strong> <code>${escHtml(String(path))}</code>${collapsibleCodeHtml(content)}</div>`
    }
    case 'edit_file': {
      const path = args.path ?? ''
      const oldStr = args.old_string ?? args.old ?? ''
      const newStr = args.new_string ?? args.new ?? ''
      return `<div class="tool-call"><strong>Edit file</strong> <code>${escHtml(String(path))}</code>`
        + collapsibleCodeHtml(oldStr, 'Old')
        + collapsibleCodeHtml(newStr, 'New')
        + `</div>`
    }
    case 'conclude': {
      const status = args.status ?? args.outcome ?? ''
      const message = args.message ?? args.content ?? ''
      // A long conclude message collapses just like any other block — the
      // "Old"/"New"-style heading is omitted since there's only ever one.
      const msgLines = String(message ?? '').split('\n')
      const messageHtml = msgLines.length > TOOL_CALL_COLLAPSE_LINES
        ? collapsibleCodeHtml(message, null, 'conclude-message-code')
        : `<div class="conclude-message">${escHtml(String(message))}</div>`
      return `<div class="tool-call conclude"><strong>Concluded</strong>${status ? ` <span class="status">${escHtml(String(status))}</span>` : ''}${messageHtml}</div>`
    }
    case 'web_search': {
      const q = args.query ?? args.q ?? ''
      return `<div class="tool-call"><strong>Search</strong> <code>${escHtml(String(q))}</code></div>`
    }
    case 'fetch_url':
    case 'browser_fetch': {
      const url = args.url ?? ''
      return `<div class="tool-call"><strong>Fetch</strong> <code>${escHtml(String(url))}</code></div>`
    }
    case 'ledger': {
      const op = args.op ?? args.action ?? ''
      const rest = Object.entries(args).filter(([k]) => k !== 'op' && k !== 'action')
        .map(([k, v]) => `${k}=${v}`).join(', ')
      return `<div class="tool-call"><strong>Ledger</strong> ${escHtml(String(op))}${rest ? ` (${escHtml(rest)})` : ''}</div>`
    }
    default: {
      const body = JSON.stringify(args, null, 2)
      return `<div class="tool-call"><strong>${escHtml(tool || 'Tool')}</strong>${collapsibleCodeHtml(body)}</div>`
    }
  }
}

// Renders a 'thought' AgentEvent's fields into a container using addTraceItem
// (the same rendering path as Bash/Result/Warning/etc.). Two distinct fields:
//   event.thinking — the model's internal chain-of-thought. Collapsible.
//   event.content  — the model's visible response text. Collapsible.
// Either can appear alone. `container` is the DOM element to append into
// (a role card's items list, or null for the top-level messagesEl).
function renderThoughtItems(event, container) {
  if (event.thinking) addTraceItem('reasoning', 'Reasoning', event.thinking, true, container)
  if (event.content) addTraceItem('response', 'Response', event.content, true, container)
}

// Routes ONE tagged event into its frame's role card. Shared by the live and replay
// paths (handleEvent/handleEventForSession) since none of this has live-only side
// effects beyond the top-level status-bar hint, which the caller applies separately.
function handleFrameEvent(event) {
  const frameId = event.__frameId
  const role = event.__role
  switch (event.type) {
    case 'start':
      getOrCreateRoleCard(frameId, role, event.query)
      break
    case 'thought':
      // The model's reasoning (event.thinking) and visible text (event.content)
      // rendered the same way as tool results/warnings — via addTraceItem into
      // this frame's role card items.
      renderThoughtItems(event, roleCards.get(frameId)?.items)
      break
    case 'tool_call': {
      // The 'conclude' call itself never renders as a trace item — the conclude
      // card rendered outside/after the accordion (see renderAgentConclusion,
      // wired from the 'done' case below) replaces it entirely. Capture its
      // status now, though: 'done' carries only the message text, not the
      // status keyword, so this is the only place that value is ever seen.
      if (event.tool === 'conclude') {
        const card = roleCards.get(frameId)
        if (card) card.status = event.args?.status ?? event.args?.outcome ?? null
        break
      }
      const wrap = document.createElement('div')
      wrap.innerHTML = formatToolCall(event.tool, event.args)
      wireToolCallExpanders(wrap)
      addRoleCardHtml(frameId, wrap.firstElementChild)
      break
    }
    case 'tool_result': {
      // Paired with the tool_call filter above — the conclude call's "0ms"
      // result is just as redundant with the conclude card as the call itself.
      if (event.tool === 'conclude') break
      const isError = !!event.error
      const label = `Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addRoleCardItem(frameId, isError ? 'tool-result error' : 'tool-result', label, body, true)
      break
    }
    case 'warning':
      addRoleCardItem(frameId, 'warning', 'Warning', event.message, false)
      break
    case 'compact':
      addRoleCardItem(frameId, 'compact', `Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      break
    case 'git_commit':
      addRoleCardItem(frameId, 'git', 'Committed', `${event.hash} — ${event.message}`, false)
      break
    case 'message':
      // Swallowed deliberately — this frame's final answer is already captured as
      // its 'done' outcome below; rendering it again here would duplicate it.
      break
    case 'done': {
      const card = roleCards.get(frameId)
      const status = card ? card.status : null
      // Close the accordion's collapsed state WITHOUT flushing a held objective
      // yet — closeRoleCardQuiet() skips that flush on purpose. Render this
      // frame's conclude card FIRST, then flush: the Dispatcher's objective card
      // must land right after its own "Dispatcher concluded" card (see
      // renderObjective's comment), which means the flush has to happen after
      // renderAgentConclusion appends to #messagesEl, not before.
      closeRoleCardQuiet(frameId)
      const meta = ROLE_META[role] || { name: role }
      renderAgentConclusion(frameId, meta.name, status, event.content)
      flushPendingObjectiveIfReady(frameId)
      break
    }
    case 'error':
      addRoleCardItem(frameId, 'error-item', 'Error', event.message, false)
      closeRoleCard(frameId)
      break
    case 'iteration':
      // Mirrors the top-level addIterationSeparator(), but nested inside this
      // frame's own accordion and counted on the card record (roleCards) for
      // the conclude card's "N iterations" meta line — see renderAgentConclusion.
      addRoleCardIterationSeparator(frameId, event.current)
      break
    case 'token_usage':
      // eval_duration_ms/total_duration_ms cover the thinking + generation time
      // for the response that just arrived — annotate the iteration divider it
      // belongs to (see annotateRoleCardIterationTiming) rather than adding a
      // separate trace item just for a number.
      if (event.total_duration_ms != null) annotateRoleCardIterationTiming(frameId, event.total_duration_ms)
      break
    // ollama_request: carries iteration/message_count ahead of the response
    // itself, but nothing here isn't already covered by 'iteration' (the
    // divider) and 'token_usage' (the timing) — no separate UI element.
  }
}

// The harness-level 'objective' event — always untagged, describing the whole task
// rather than one frame's turn. It is the Dispatcher's own conclusion, emitted
// alongside/around the Dispatcher frame's 'done' — so rather than dropping it into
// the chat immediately (which would show it ABOVE the Dispatcher's trace, i.e.
// before the work that produced it), it's held until the most recently active
// Dispatcher frame card closes, then appended right after. If no Dispatcher frame
// is currently open (legacy path, or the event arrived with nothing to
// wait for), it renders immediately as before.
function renderObjective(event) {
  lastObjectiveText = String(event.text ?? '')
  if (activeDispatcherFrameId && roleCards.has(activeDispatcherFrameId)) {
    pendingObjective = event
    return
  }
  renderObjectiveNow(event)
}

function renderObjectiveNow(event) {
  const el = document.createElement('div')
  el.className = 'message objective'
  el.innerHTML = `<div class="objective-title">Objective</div><div class="objective-text">${escHtml(event.text).replace(/\n/g, '<br>')}</div>`
  messagesEl.appendChild(el)
  maybeAutoScroll()
}

// Called whenever a role card closes (see closeRoleCard) — flushes a held
// objective once the Dispatcher frame it was waiting on has actually finished.
function flushPendingObjectiveIfReady(frameId) {
  if (pendingObjective && frameId === activeDispatcherFrameId) {
    activeDispatcherFrameId = null
    const ev = pendingObjective
    pendingObjective = null
    renderObjectiveNow(ev)
  }
}

// Many harness conclusions restate the objective verbatim before the actual
// answer (the model echoing back what it was asked to do). The objective
// already has its own card — repeating it in the conclusion card is just
// noise. Strips an exact (whitespace-insensitive-at-the-boundary) leading
// match of the last-seen objective text, plus any separating blank
// line/rule left behind, and returns what's left. Falls back to the
// original text untouched if there's no such duplication.
function stripDuplicatedObjective(text) {
  const obj = lastObjectiveText.trim()
  if (!obj || !text) return text
  const trimmed = text.trim()
  if (!trimmed.startsWith(obj)) return text
  let rest = trimmed.slice(obj.length)
  // Drop a leading separator the model may have inserted between the restated
  // objective and its actual conclusion — blank lines, a markdown rule, or a
  // leading colon/dash.
  rest = rest.replace(/^\s*(?:[-–—:]\s*|\n?(?:\s*[-*_]{3,}\s*\n)?)*/, '')
  return rest.trim() || text
}

// Agent-conclusion card — the harness's 'done' content, displayed as its OWN
// card (same visual family as the Objective card, distinct accent) rather
// than as a plain chat message. Rendered AFTER that agent's trace section
// (role card, or the top-level run). `label` is the
// heading, e.g. "Dispatcher concluded" / "Implementer concluded".
// Guards against rendering the exact same conclusion twice under the same label —
// some harness builds emit the same final answer on BOTH the 'message' and
// 'done' events; only the first should become a card.
let lastConclusionKey = ''

function renderConclusionCard(label, content) {
  if (content == null || content === '') return
  // Every live run is a dispatch run (see startTraceBlock's comment) — the
  // harness's own top-level 'message'/'done' restate the exact SAME final
  // answer that a per-agent conclude card (renderAgentConclusion) already
  // rendered for whichever frame actually produced it. Once that's happened
  // this run, a generic "Agent concluded" card here would be a pure duplicate,
  // not a second real conclusion — suppress it rather than render it and rely
  // on lastConclusionKey (which only catches an EXACT byte-for-byte repeat,
  // not this case: label differs ("Agent concluded" vs "Dispatcher concluded")
  // and the text can differ too, e.g. after stripDuplicatedObjective).
  if (anyFrameConcludedThisRun) return
  const key = `${label}\u0000${content}`
  if (key === lastConclusionKey) return
  lastConclusionKey = key
  const text = stripDuplicatedObjective(String(content))
  if (!text.trim()) return
  const el = document.createElement('div')
  // `md` on the OUTER element (not just conclusion-text) so the shared
  // .message.md markdown rules (paragraphs, code blocks, lists, etc. — see
  // styles.css) apply the same way they do for a plain assistant bubble.
  el.className = 'message conclusion md'
  el.innerHTML = `<div class="conclusion-title">${escHtml(label)}</div><div class="conclusion-text">${renderMarkdown(text)}</div>`
  el.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'))
  messagesEl.appendChild(el)
  maybeAutoScroll()
}

// Per-frame conclude card — the multi-agent counterpart to renderConclusionCard
// above, rendered directly in #messagesEl right after that frame's accordion
// (see getOrCreateRoleCard/closeRoleCard) rather than nested inside it. Carries
// the `conclude` tool call's full detail — status keyword AS A BADGE (SIMPLE,
// SUCCESS, FAIL, ANSWER, ...) plus the message, markdown-rendered — replacing
// both the (deliberately unrendered) 'conclude' tool_call and its "0ms"
// tool_result inside the accordion. `role` is the short display name
// (ROLE_META[...].name, e.g. "Dispatcher") used to build the "<Role> concluded"
// heading; `status` may be null for a build that never captured one.
// Same lastConclusionKey de-dup as renderConclusionCard — a harness that emits
// the same frame's 'done' twice (e.g. across replay + live) shouldn't double the card.
function renderAgentConclusion(frameId, role, status, content) {
  if (content == null || content === '') return
  const key = `${role}\u0000${status}\u0000${content}`
  if (key === lastConclusionKey) return
  lastConclusionKey = key
  // Marks this run as having a per-agent conclude card — see the flag's own
  // comment — so the harness's own top-level 'message'/'done' (dispatch.ts's
  // untagged echo of the same final answer) doesn't ALSO render a generic
  // "Agent concluded" card underneath/on top of this one. Set even if the
  // text below turns out to be empty after stripping a duplicated objective —
  // a real per-agent conclusion happened either way.
  anyFrameConcludedThisRun = true
  const text = stripDuplicatedObjective(String(content))
  if (!text.trim()) return
  const statusClass = status ? `status-${String(status).toLowerCase()}` : ''
  const el = document.createElement('div')
  el.className = `message conclusion agent-conclusion md ${statusClass}`.trim()
  // "N iterations · Ts" meta line — tracked per-frame on the role card record
  // (iterations incremented on each 'iteration' event, startTime stamped when
  // the card was created — see getOrCreateRoleCard/addRoleCardIterationSeparator).
  // Omitted (rather than showing "0 iterations · 0.0s") for a card that somehow
  // has no record left (frameId not in roleCards) — should not normally happen,
  // since this is called right after closeRoleCardQuiet() on the SAME frameId.
  const card = roleCards.get(frameId)
  const metaHtml = card
    ? `<span class="conclude-meta">${card.iterations} iteration${card.iterations !== 1 ? 's' : ''} · ${fmtDuration(Date.now() - card.startTime)}</span>`
    : ''
  // Agent color on the role label only, keyed off the frame's actual role
  // (card.role, e.g. "dispatcher") rather than the display name passed in.
  // Deliberately layered alongside — not replacing — the existing
  // status-keyword coloring (border/background/status-badge, set by the
  // CSS status-* rules above): an inline style here would win over those
  // regardless of selector specificity, so this only ever touches the label
  // text/dot, never border-left-color or background.
  const agentColor = card ? AGENT_COLORS[card.role] : null
  const roleLabelHtml = agentColor
    ? `<span class="conclude-role-label" style="color:${agentColor}"><span class="conclude-role-dot" style="background:${agentColor}"></span>${escHtml(role)}</span>`
    : escHtml(role)
  el.innerHTML = `<div class="conclusion-title">${roleLabelHtml} concluded`
    + (status ? `<span class="status">${escHtml(String(status))}</span>` : '')
    + metaHtml
    + `</div><div class="conclusion-text">${renderMarkdown(text)}</div>`
  el.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'))
  messagesEl.appendChild(el)
  maybeAutoScroll()
}

function renderMarkdown(content) {
  return marked.parse(content, { breaks: true, gfm: true })
}

function addChatMessage(role, content) {
  const el = document.createElement('div')
  el.className = `message ${role} md`
  el.innerHTML = renderMarkdown(content)
  el.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'))

  if (role === 'assistant') {
    const copyBtn = document.createElement('button')
    copyBtn.className = 'msg-copy-btn'
    copyBtn.type = 'button'
    copyBtn.textContent = 'Copy'
    copyBtn.addEventListener('click', async () => {
      clearTimeout(copyBtn._resetTimer)
      try {
        await navigator.clipboard.writeText(content)
        copyBtn.textContent = 'Copied'
        copyBtn.classList.add('copied')
      } catch {
        copyBtn.textContent = 'Failed'
      }
      copyBtn._resetTimer = setTimeout(() => {
        copyBtn.textContent = 'Copy'
        copyBtn.classList.remove('copied')
      }, 1500)
    })
    el.appendChild(copyBtn)
  }

  messagesEl.appendChild(el)
  maybeAutoScroll()
}

function addSystemMessage(text) {
  const el = document.createElement('div')
  el.className = 'message system'
  el.textContent = text
  messagesEl.appendChild(el)
  maybeAutoScroll()
}

// ── Prompt queue ─────────────────────────────────────────────────
// Start an actual run: shared by direct submit and auto-advance. On failure
// (bad response or network) the message is re-queued at the FRONT so nothing
// is lost, and busy is cleared.
async function startRun(message) {
  // Ask for notification permission on the first run (a user gesture); harmless if denied.
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission() } catch { /* ignore */ } }
  if (!currentSessionQuery) {
    currentSessionQuery = message
  }
  addChatMessage('user', message)
  setBusy(true)

  try {
    const resp = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, model: selectedModel, options: modelOpts, maxIterations, grounding, autoCommit }),
    })
    if (!resp.ok) {
      const err = await resp.json()
      addSystemMessage(`Error: ${err.error}`)
      setBusy(false)
      promptQueue.unshift({ id: nextQueueId(), text: message })
      renderQueue()
    }
  } catch (err) {
    addSystemMessage(`Network error: ${err.message}`)
    setBusy(false)
    promptQueue.unshift({ id: nextQueueId(), text: message })
    renderQueue()
  }
}

let queueIdCounter = 0
function nextQueueId() {
  queueIdCounter += 1
  return queueIdCounter
}

function enqueuePrompt(text) {
  promptQueue.push({ id: nextQueueId(), text })
  renderQueue()
}

function renderQueue() {
  const container = $('prompt-queue')
  if (!container) return
  container.innerHTML = ''
  if (!promptQueue.length) {
    container.classList.remove('has-items')
    return
  }
  container.classList.add('has-items')
  for (const item of promptQueue) {
    const card = document.createElement('div')
    card.className = 'queue-item'

    const textEl = document.createElement('div')
    textEl.className = 'queue-item-text'
    textEl.textContent = item.text

    const actions = document.createElement('div')
    actions.className = 'queue-item-actions'

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'icon-btn queue-item-btn'
    editBtn.title = 'Edit'
    editBtn.textContent = '✎'
    editBtn.addEventListener('click', () => editQueued(item.id))

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'icon-btn queue-item-btn'
    delBtn.title = 'Remove'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => deleteQueued(item.id))

    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    card.appendChild(textEl)
    card.appendChild(actions)
    container.appendChild(card)
  }
}

function editQueued(id) {
  const idx = promptQueue.findIndex(it => it.id === id)
  if (idx === -1) return
  const [item] = promptQueue.splice(idx, 1)
  inputEl.value = item.text
  inputEl.focus()
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
  autoGrow()
  renderQueue()
}

function deleteQueued(id) {
  const idx = promptQueue.findIndex(it => it.id === id)
  if (idx === -1) return
  promptQueue.splice(idx, 1)
  renderQueue()
}

// ── Chat form ────────────────────────────────────────────────────
$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const text = inputEl.value.trim()

  if (busy) {
    // Agent running: Enter queues a new prompt. (The button while busy is the
    // STOP button, handled separately in the sendBtn click listener.)
    if (text) {
      enqueuePrompt(text)
      inputEl.value = ''
      autoGrow()
    }
    return
  }

  // Idle:
  if (text) {
    // Run the typed prompt now (an explicit new prompt takes priority; any
    // paused queue stays and resumes after this run completes naturally).
    inputEl.value = ''
    autoGrow()
    startRun(text)
  } else if (promptQueue.length) {
    // Empty submit with a non-empty queue: run the TOP of the queue.
    const next = promptQueue.shift()
    renderQueue()
    startRun(next.text)
  }
  // else: empty submit, empty queue -> no-op.
})

// Programmatic insertion into #input that participates in the native
// undo/redo stack (Cmd/Ctrl+Z, Shift+Z, Y). setRangeText() is a scripted DOM
// Range mutation that browsers don't reliably coalesce into one undo step;
// execCommand('insertText', ...) is treated as a real edit, same as a native
// paste or keystroke. Falls back to setRangeText if execCommand is
// unavailable or returns false (older/future browsers).
function insertTextUndoable(text) {
  inputEl.focus()
  let ok = false
  try { ok = document.execCommand('insertText', false, text) } catch { ok = false }
  if (!ok) {
    inputEl.setRangeText(text, inputEl.selectionStart, inputEl.selectionEnd, 'end')
  }
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
    e.preventDefault()
    $('chat-form').dispatchEvent(new Event('submit'))
  } else if (e.key === 'Enter' && e.altKey && !e.isComposing) {
    // Alt+Enter doesn't insert a newline by default, so do it explicitly —
    // via insertTextUndoable so the newline is undoable like any other edit.
    e.preventDefault()
    insertTextUndoable('\n')
  }
})

// Auto-grow the textarea vertically as newlines are added, up to a cap
// (40vh, floor ~200px), then scroll internally.
function autoGrow() {
  const max = Math.max(200, Math.round(window.innerHeight * 0.4))
  inputEl.style.height = 'auto'
  const h = Math.min(inputEl.scrollHeight, max)
  inputEl.style.height = h + 'px'
  inputEl.style.overflowY = inputEl.scrollHeight > max ? 'auto' : 'hidden'
}
inputEl.addEventListener('input', autoGrow)
autoGrow()

// Rich text (Google Docs, web pages, email, etc.) carries a text/html
// clipboard entry with real semantic formatting — convert that to Markdown
// instead of pasting formatted junk into the textarea. But a text/html entry
// alone isn't a reliable "this is rich text" signal: code editors, terminals,
// and plenty of plain-text apps also attach an incidental text/html entry
// purely for font/color styling (e.g. "<span style="color:#d4d4d4">const x
// = 1</span>") with no real structure — converting *that* through Turndown
// just re-escapes ordinary characters (_, *, [, etc.) for no reason. Only
// treat the clipboard as rich text if the HTML actually contains a tag that
// represents real formatting a user would want preserved as Markdown.
const RICH_HTML_TAGS = /<(b|strong|i|em|a\s|a>|ul|ol|li|h[1-6]|blockquote|table|s|strike|del)\b/i
const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
// Turndown's default escape() backslash-escapes markdown-special characters
// (_, *, `, [, ], leading -/+/#/>/digit.) in every plain text node — correct
// for producing byte-perfect Markdown source, but this textarea is a chat
// prompt, not a markdown file: escaping a variable name like "my_var" into
// "my\_var" sends literal backslashes to both the display and the LLM.
// Disabling it keeps the *structural* conversion (bold, links, lists)
// without mangling ordinary prose.
turndownService.escape = string => string
// A normal rich paste converts HTML→markdown. Cmd/Ctrl+Shift+V ("paste and match style")
// should instead paste PLAIN text with no formatting (bold text → "bold text", not
// "**bold text**"): the keydown arms a flag that the paste handler honors by letting the
// browser's default plain-text paste run (a textarea inserts clipboard text/plain).
let plainPasteArmed = false
// Cmd/Ctrl+Shift+V ("paste and match style") arms plain-text paste. So does
// Cmd/Ctrl+Alt+Shift+V — matching on e.code (not just e.key) because some
// OS/keyboard layouts turn Option/Alt+V's `key` into a different character
// (e.g. "√" on macOS), which would otherwise silently miss the shortcut
// whenever Alt is held.
inputEl.addEventListener('keydown', (e) => {
  const isV = e.code === 'KeyV' || e.key === 'v' || e.key === 'V'
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && isV) {
    plainPasteArmed = true
    setTimeout(() => { plainPasteArmed = false }, 500)
  }
})
inputEl.addEventListener('paste', (e) => {
  if (plainPasteArmed) { plainPasteArmed = false; return }  // Cmd/Ctrl+(Alt+)Shift+V → plain text, no markdown conversion
  const html = e.clipboardData?.getData('text/html')
  if (!html || !RICH_HTML_TAGS.test(html)) return  // let the browser's normal plain-text paste happen
  e.preventDefault()
  const markdown = turndownService.turndown(html).trim()
  insertTextUndoable(markdown)
})

// ── Prompt navigation (Up/Down) ───────────────────────────────────
// When focus is anywhere OTHER than a text input (i.e. not actively typing),
// Up/Down walks between past USER prompts in the message list instead of
// doing nothing — handy for re-reading "what did I actually ask" without
// grabbing the mouse. The index is recomputed against the live list on every
// press so it stays correct even as new messages arrive meanwhile.
let promptNavIndex = -1
function navigatePrompts(dir) {
  const prompts = messagesEl.querySelectorAll('.message.user')
  if (!prompts.length) return
  if (promptNavIndex < 0 || promptNavIndex >= prompts.length) {
    promptNavIndex = prompts.length - 1
  } else {
    promptNavIndex = Math.max(0, Math.min(prompts.length - 1, promptNavIndex + dir))
  }
  prompts[promptNavIndex].scrollIntoView({ behavior: 'smooth', block: 'center' })
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const active = document.activeElement
  const tag = active && active.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT' || (active && active.isContentEditable)) return
  if (!messagesEl.querySelector('.message.user')) return
  e.preventDefault()
  navigatePrompts(e.key === 'ArrowUp' ? -1 : 1)
})

// ── New session (clear the conversation) ─────────────────────────
async function newSession() {
  // Clear replay/boundary state for the fresh session.
  $('chat-form').style.display = ''
  replaying = false
  pendingEvents = []
  liveRunMaxSeq = 0

  await fetch(`${API_BASE}/reset`, { method: 'POST' })
  sessionStartTime = new Date()
  currentSessionQuery = ''
  traceRunActive = false
  roleCards.clear()
  messagesEl.innerHTML = '<div class="message system">New session started.</div>'
  messagesAtBottom = true
  scrollBottomBtn.classList.add('hidden')
  promptNavIndex = -1
  // A fresh session starts with no queued prompts.
  promptQueue.length = 0
  renderQueue()

  iterLabel.textContent = ''
  compactingNow = false
  setStatus('ready', 'Ready')
  // Track the new live session id so its events are the ones replayed later.
  const st = await fetch(`${API_BASE}/status`).then(r => r.json()).catch(() => ({}))
  currentLiveSessionId = st?.sessionId ?? ''
}

// ── Dropdown mutual exclusion ─────────────────────────────────────
function closeAllDropdowns() {
  document.querySelectorAll('.nav-crumb.open').forEach(el => el.classList.remove('open'))
  if (isSettingsOpen()) cancelSettingsPanel()
}
document.addEventListener('click', closeAllDropdowns)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDropdowns() })

// ── Model selector ───────────────────────────────────────────────
// Model selection now lives inside the settings panel (#opt-model), as the
// first control — the old standalone toolbar "#nav-model" crumb is gone; the
// combined indicator's status row opens this same settings panel instead.
function selectModel(name) {
  selectedModel = name
  const sel = $('opt-model')
  if (sel && sel.value !== name) sel.value = name
  // The indicator's dropdown status row shows the model name — keep it live
  // if the dropdown happens to be open while the model changes.
  if (navCtx.classList.contains('open')) buildCtxDropdown()
}

async function loadModels() {
  const select = $('opt-model')

  // Model choice lives in the settings dropdown now — an edit here only
  // updates the draft; selectModel() (which actually applies it) fires from
  // saveSettingsPanel() on Save.
  select.addEventListener('change', e => { if (settingsDraft) settingsDraft.model = e.target.value })

  try {
    const resp = await fetch(`${API_BASE}/models`)
    const models = await resp.json()
    select.innerHTML = ''
    models.forEach(name => {
      const opt = document.createElement('option')
      opt.value = name
      const toolBadge = (name.startsWith('qwen3') || name.startsWith('devstral')) ? ' 🔧' : ''
      const noToolBadge = (name.startsWith('gemma')) ? ' ⚠️ no tool support' : ''
      opt.textContent = `${name}${toolBadge}${noToolBadge}`
      select.appendChild(opt)
    })
    // Default to qwen3.6 (the validated best model) when it's in the list,
    // falling back to the first model otherwise. This only picks the
    // DEFAULT — applySessionSettings()/a sticky restored model still wins
    // when this runs before/after that, since selectModel() here just sets
    // the initial value and later calls simply overwrite it.
    if (models.length) {
      const preferred = models.find(name => name === 'qwen3.6' || name.startsWith('qwen3.6'))
      selectModel(preferred || models[0])
    }
  } catch {
    const fallback = 'llama3.1:8b'
    select.innerHTML = ''
    const opt = document.createElement('option')
    opt.value = fallback
    opt.textContent = fallback
    select.appendChild(opt)
    selectModel(fallback)
  }
}

// ── Git log ──────────────────────────────────────────────────────
function makeCommitEntry(c) {
  const el = document.createElement('div')
  el.className = 'git-entry'
  el.innerHTML = `
    <span class="git-hash">${c.short}</span>
    <span class="git-message">${escHtml(c.message)}</span>
    <span class="git-date">${formatDate(c.date)}</span>
    <button class="git-diff-btn" data-hash="${c.hash}">diff</button>
  `
  el.querySelector('.git-diff-btn').addEventListener('click', () => showDiff(c.hash))
  return el
}

async function refreshGitLog() {
  const latestEl = $('git-latest')
  const oldToggle = $('git-toggle')
  if (oldToggle) oldToggle.remove()

  try {
    const resp = await fetch(`${API_BASE}/git-log`)
    const commits = await resp.json()

    latestEl.innerHTML = ''
    gitLog.innerHTML = ''
    gitLog.classList.remove('open')

    if (commits.length === 0) {
      latestEl.innerHTML = '<span class="muted-sm">No commits yet</span>'
      return
    }

    const c = commits[0]
    latestEl.innerHTML = `
      <span class="git-hash">${c.short}</span>
      <span class="git-message">${escHtml(c.message)}</span>
      <span class="git-date">${formatDate(c.date)}</span>
      <button class="git-diff-btn" data-hash="${c.hash}">diff</button>
    `
    latestEl.querySelector('.git-diff-btn').addEventListener('click', () => showDiff(c.hash))

    if (commits.length > 1) {
      const older = commits.slice(1)
      older.forEach(c => gitLog.appendChild(makeCommitEntry(c)))

      const toggleBtn = document.createElement('button')
      toggleBtn.id = 'git-toggle'
      toggleBtn.className = 'git-toggle-btn'
      let expanded = false
      const toggle = () => {
        expanded = !expanded
        gitLog.classList.toggle('open', expanded)
        toggleBtn.textContent = expanded ? '▲' : `▼ ${older.length}`
      }
      toggleBtn.textContent = `▼ ${older.length}`
      toggleBtn.addEventListener('click', toggle)
      $('refresh-git').insertAdjacentElement('beforebegin', toggleBtn)
    }
  } catch {
    latestEl.innerHTML = '<span class="muted-sm">Could not load git log.</span>'
  }
}

async function showDiff(hash) {
  diffContent.textContent = 'Loading…'
  diffTitle.textContent = hash.slice(0, 7)
  ctxFrameBar.classList.add('hidden')   // this modal use has no frames to pick from
  diffModal.classList.add('open')

  try {
    const resp = await fetch(`${API_BASE}/git-diff/${hash}`)
    const text = await resp.text()
    diffContent.innerHTML = colorize(text)
  } catch {
    diffContent.textContent = 'Failed to load diff.'
  }
}

// Shared unified-diff colorizer — used by the "View diff" modal (#diff-content,
// via showDiff()) AND by the Changes-mode viewer-pane diffs (#file-viewer-content.diff-view,
// via renderDiffIntoViewer()). Classes are global (.diff-add/.diff-del/.diff-meta in
// styles.css), not scoped to either container, precisely so this one function serves both.
function colorize(text) {
  return text.split('\n').map(line => {
    const esc = escHtml(line)
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${esc}</span>`
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${esc}</span>`
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) return `<span class="diff-meta">${esc}</span>`
    return esc
  }).join('\n')
}

$('refresh-git').addEventListener('click', refreshGitLog)
$('close-diff').addEventListener('click', () => diffModal.classList.remove('open'))
diffModal.addEventListener('click', (e) => { if (e.target === diffModal) diffModal.classList.remove('open') })

// ── Files tab ────────────────────────────────────────────────────
// A single tree rooted at the container's real filesystem (or the mounted
// workspace directory in standalone dev mode, which has no broader container
// to browse) — /workspace is the only directory treated specially (expanded
// and labeled by default). Directories load their children lazily on first
// expand rather than eagerly walking the whole tree up front, since the root
// can now be the entire container filesystem.
async function fetchDirChildren(relPath) {
  const qs = relPath ? `?path=${encodeURIComponent(relPath)}` : ''
  return fetch(`${API_BASE}/files${qs}`).then(r => r.json()).catch(() => [])
}

async function refreshFiles() {
  // Preserve which directories are expanded and which file is selected across the rebuild,
  // so live refreshes (as the agent creates/edits files) don't collapse the tree or drop
  // the current selection.
  const wasOpen = [...fileNodeMap.entries()].filter(([, n]) => n.type === 'dir' && n.wrapperEl && n.wrapperEl.classList.contains('open')).map(([p]) => p)
  const wasActive = currentViewerPath
  const container = $('files-tree')
  container.innerHTML = ''
  fileNodeMap.clear()
  const rootNodes = await fetchDirChildren('')
  if (!rootNodes.length) {
    const el = document.createElement('div')
    el.className = 'file-empty'
    el.textContent = '(empty)'
    container.appendChild(el)
    return
  }
  for (const node of rootNodes) {
    const isProject = node.type === 'dir' && node.name === 'workspace'
    container.appendChild(await makeFileNode(node, '', isProject))
  }
  // Re-expand previously-open dirs, shallowest first (an ancestor must load its children
  // before a descendant can be found and expanded).
  for (const p of wasOpen.sort((a, b) => a.split('/').length - b.split('/').length)) {
    const n = fileNodeMap.get(p)
    if (n && n.expand) { try { await n.expand() } catch { /* dir gone */ } }
  }
  // Re-mark the active file row if it still exists.
  if (wasActive) {
    const t = fileNodeMap.get(wasActive)
    if (t && t.rowEl) { if (activeFileRow) activeFileRow.classList.remove('active'); activeFileRow = t.rowEl; t.rowEl.classList.add('active') }
  }
}

// Debounced live refresh of the workspace panels while the agent works: rebuilds the
// left pane's list (tree in Files mode, changes list in Changes mode) and re-renders
// whatever's currently shown on the right (an open file/preview, or a diff), so newly
// created files appear and a touched-and-viewed file/diff updates in place. Debounced
// so a burst of edits triggers one refresh. Shares refreshWorkspacePane() with the
// header's manual "Refresh" button so both refresh the same things the same way.
let wsRefreshTimer = null
function scheduleWorkspaceRefresh() {
  clearTimeout(wsRefreshTimer)
  wsRefreshTimer = setTimeout(refreshWorkspacePane, 700)
}

// ── Files / Changes toggle ────────────────────────────────────────
const filesModeToggle = $('files-mode-toggle')

function setFilesMode(mode) {
  if (mode === filesMode) return
  filesMode = mode
  filesModeToggle.querySelectorAll('.vt-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode))
  // A file/diff selected in one mode isn't meaningful in the other.
  closeViewer()
  if (mode === 'files') refreshFiles()
  else refreshChanges()
}
filesModeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.vt-btn')
  if (!btn) return
  setFilesMode(btn.dataset.mode)
})

// ── Changes mode — VS Code-style git view ──────────────────────────
// Renders into the SAME #files-tree container the file tree uses (only one
// of the two is ever shown, per filesMode) — a "Changes" section of
// uncommitted working-tree changes (GET /git-status) above a commit
// "History" section (GET /git-log), each commit lazily expandable to its
// changed files (GET /commit-files/:hash). Clicking any file/change row
// shows that file's diff in the viewer pane via colorize() — the same
// renderer the "View diff" modal uses, not a second implementation.
function statusGlyph(status) {
  return (String(status || '').trim().charAt(0) || '?').toUpperCase()
}

function statusClass(status) {
  const s = statusGlyph(status)
  if (s === 'A' || s === '?') return 'git-status-add'
  if (s === 'D') return 'git-status-del'
  if (s === 'R' || s === 'C') return 'git-status-move'
  return 'git-status-mod'
}

async function refreshChanges() {
  const container = $('files-tree')
  container.innerHTML = '<div class="file-empty">Loading…</div>'

  let statusRows = []
  let commits = []
  try { statusRows = await fetch(`${API_BASE}/git-status`).then(r => r.json()) } catch { /* keep empty */ }
  try { commits = await fetch(`${API_BASE}/git-log`).then(r => r.json()) } catch { /* keep empty */ }

  container.innerHTML = ''

  const changesSection = document.createElement('div')
  changesSection.className = 'changes-section'
  const changesLabel = document.createElement('div')
  changesLabel.className = 'changes-section-label'
  changesLabel.textContent = `Changes${statusRows.length ? ` (${statusRows.length})` : ''}`
  changesSection.appendChild(changesLabel)
  if (!statusRows.length) {
    const empty = document.createElement('div')
    empty.className = 'file-empty'
    empty.textContent = 'No uncommitted changes'
    changesSection.appendChild(empty)
  } else {
    for (const row of statusRows) changesSection.appendChild(makeChangeRow(row))
  }
  container.appendChild(changesSection)

  const historySection = document.createElement('div')
  historySection.className = 'changes-section'
  const historyLabel = document.createElement('div')
  historyLabel.className = 'changes-section-label'
  historyLabel.textContent = 'History'
  historySection.appendChild(historyLabel)
  if (!commits.length) {
    const empty = document.createElement('div')
    empty.className = 'file-empty'
    empty.textContent = 'No commits yet'
    historySection.appendChild(empty)
  } else {
    for (const c of commits) historySection.appendChild(makeCommitRow(c))
  }
  container.appendChild(historySection)
}

function makeChangeRow(row) {
  const el = document.createElement('div')
  el.className = 'file-row change-row'
  el.innerHTML = `<span class="git-status-glyph ${statusClass(row.status)}">${escHtml(statusGlyph(row.status))}</span><span class="file-name">${escHtml(row.path)}</span>`
  el.addEventListener('click', () => showWorkingDiff(row.path, el))
  return el
}

// A commit row expands (lazily, like a tree directory) to a detail block
// (full message + hash/date) followed by its changed files, fetched via
// GET /commit-files/:hash. The folded row shows only the subject — no
// hash/date/relative time (kept clean; those surface once expanded).
function makeCommitRow(c) {
  const wrapper = document.createElement('div')
  wrapper.className = 'commit-node'

  const row = document.createElement('div')
  row.className = 'file-row commit-row'
  row.innerHTML = `<span class="file-icon">▶</span><span class="file-name commit-message">${escHtml(c.message)}</span>`

  const detail = document.createElement('div')
  detail.className = 'commit-detail'
  const fullMessage = c.body ? `${c.message}\n\n${c.body}` : c.message
  const hash = (c.hash || c.short || '').slice(0, 8) || c.short || ''
  const parsedDate = c.date ? new Date(c.date) : null
  const dateText = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toLocaleString() : (c.date || '')
  detail.innerHTML = `<div class="commit-full-message">${escHtml(fullMessage)}</div><div class="commit-meta"><span class="commit-hash">${escHtml(hash)}</span><span class="commit-date">${escHtml(dateText)}</span></div>`

  const filesWrap = document.createElement('div')
  filesWrap.className = 'file-children'
  let loaded = false

  row.addEventListener('click', async () => {
    const opening = !wrapper.classList.contains('open')
    if (opening && !loaded) {
      loaded = true
      let files = []
      try { files = await fetch(`${API_BASE}/commit-files/${c.hash}`).then(r => r.json()) } catch { /* keep empty */ }
      filesWrap.innerHTML = ''
      if (!files.length) {
        const empty = document.createElement('div')
        empty.className = 'file-empty'
        empty.textContent = '(no files)'
        filesWrap.appendChild(empty)
      } else {
        for (const f of files) filesWrap.appendChild(makeCommitFileRow(c, f))
      }
    }
    wrapper.classList.toggle('open', opening)
    row.querySelector('.file-icon').textContent = opening ? '▼' : '▶'
  })

  wrapper.appendChild(row)
  wrapper.appendChild(detail)
  wrapper.appendChild(filesWrap)
  return wrapper
}

function makeCommitFileRow(c, f) {
  const el = document.createElement('div')
  el.className = 'file-row change-row'
  el.innerHTML = `<span class="git-status-glyph ${statusClass(f.status)}">${escHtml(statusGlyph(f.status))}</span><span class="file-name">${escHtml(f.path)}</span>`
  el.addEventListener('click', () => showCommitFileDiff(c.hash, f.path, el))
  return el
}

function markActiveChangeRow(rowEl) {
  if (activeChangeRow) activeChangeRow.classList.remove('active')
  activeChangeRow = rowEl || null
  if (rowEl) rowEl.classList.add('active')
}

// Shared render for both a working-tree diff and a per-commit file diff — same
// colorize() used by the "View diff" modal, just rendered into the viewer pane
// instead of #diff-content.
async function renderDiffIntoViewer(path, fetchUrl) {
  if (activeFileRow) { activeFileRow.classList.remove('active'); activeFileRow = null }
  currentViewerPath = null
  setViewerPathText(path)
  $('file-viewer-toggle').classList.add('hidden')   // diffs aren't previewable
  const contentEl = $('file-viewer-content')
  contentEl.classList.remove('file-viewer-empty', 'preview-mode')
  contentEl.classList.add('diff-view')
  contentEl.textContent = 'Loading…'
  try {
    const resp = await fetch(fetchUrl)
    const text = await resp.text()
    contentEl.innerHTML = colorize(text) || '<span class="muted-sm">(no changes)</span>'
  } catch {
    contentEl.textContent = 'Failed to load diff.'
  }
}

async function showWorkingDiff(path, rowEl) {
  markActiveChangeRow(rowEl)
  currentDiffRef = { type: 'working', path }
  await renderDiffIntoViewer(path, `${API_BASE}/git-diff-working?path=${encodeURIComponent(path)}`)
}

async function showCommitFileDiff(hash, path, rowEl) {
  markActiveChangeRow(rowEl)
  currentDiffRef = { type: 'commit', hash, path }
  await renderDiffIntoViewer(path, `${API_BASE}/git-diff/${hash}?path=${encodeURIComponent(path)}`)
}

// Refreshes BOTH the left pane's list (tree or changes) and whatever's
// currently shown on the right (an open file/preview, or a diff) — the
// header's "Refresh" action.
async function refreshWorkspacePane() {
  if (filesMode === 'files') {
    await refreshFiles()
    if (currentViewerPath) {
      const kind = window.ArgoPreview ? ArgoPreview.previewKindFor(currentViewerPath) : null
      await renderViewer(currentViewerPath, kind)
    }
  } else {
    await refreshChanges()
    if (currentDiffRef) {
      const url = currentDiffRef.type === 'working'
        ? `${API_BASE}/git-diff-working?path=${encodeURIComponent(currentDiffRef.path)}`
        : `${API_BASE}/git-diff/${currentDiffRef.hash}?path=${encodeURIComponent(currentDiffRef.path)}`
      await renderDiffIntoViewer(currentDiffRef.path, url)
    }
  }
}

// Only refreshes the Changes lists if that's the active mode — called after
// events that change git state (a commit, or a run finishing) so an open
// Files-mode tree isn't refetched needlessly.
function refreshChangesIfActive() {
  if (filesMode === 'changes') refreshChanges()
}

// ── Auto-commit toggle ─────────────────────────────────────────────
// Whether the worker should commit the agent's changes after each run.
// Default OFF; sent with every /chat request (like `grounding`) so the
// worker's per-run behavior matches this toggle. Initialized from /status's
// `autoCommit` on boot (see boot()).
let autoCommit = false
const autoCommitBtn = $('auto-commit-toggle')
function syncAutoCommitUI() {
  autoCommitBtn.classList.toggle('on', autoCommit)
}
autoCommitBtn.addEventListener('click', () => {
  autoCommit = !autoCommit
  syncAutoCommitUI()
})

async function makeFileNode(node, parentPath, forceOpen = false) {
  const filePath = parentPath ? `${parentPath}/${node.name}` : node.name
  const wrapper = document.createElement('div')

  if (node.type === 'dir') {
    wrapper.className = 'file-node dir'
    const row = document.createElement('div')
    row.className = 'file-row'
    const label = filePath === 'workspace' ? 'workspace/ (project)' : `${node.name}/`
    row.innerHTML = `<span class="file-icon">▶</span><span class="file-name">${escHtml(label)}</span>`

    const children = document.createElement('div')
    children.className = 'file-children'
    let loaded = false

    async function loadChildren() {
      if (loaded) return
      loaded = true
      const childNodes = await fetchDirChildren(filePath)
      children.innerHTML = ''
      if (!childNodes.length) {
        const empty = document.createElement('div')
        empty.className = 'file-empty'
        empty.textContent = '(empty)'
        children.appendChild(empty)
        return
      }
      for (const child of childNodes) children.appendChild(await makeFileNode(child, filePath))
    }

    row.addEventListener('click', async () => {
      const opening = !wrapper.classList.contains('open')
      if (opening) await loadChildren()
      wrapper.classList.toggle('open', opening)
      row.querySelector('.file-icon').textContent = opening ? '▼' : '▶'
    })

    wrapper.appendChild(row)
    wrapper.appendChild(children)

    // Programmatic expand used by selectFileInTree to walk lazy ancestors.
    async function expand() {
      await loadChildren()
      wrapper.classList.add('open')
      row.querySelector('.file-icon').textContent = '▼'
    }
    fileNodeMap.set(filePath, { type: 'dir', rowEl: row, wrapperEl: wrapper, expand })

    if (forceOpen) {
      await expand()
    }
  } else {
    wrapper.className = 'file-node file'
    const row = document.createElement('div')
    row.className = 'file-row'
    const size = node.size != null ? formatSize(node.size) : ''
    row.innerHTML = `<span class="file-icon">·</span><span class="file-name">${escHtml(node.name)}</span><span class="file-size">${size}</span>`
    row.addEventListener('click', () => openFileInViewer(filePath, row))
    wrapper.appendChild(row)
    fileNodeMap.set(filePath, { type: 'file', rowEl: row, wrapperEl: wrapper })
  }

  return wrapper
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

let activeFileRow = null
let currentViewerPath = null
// path -> { type:'dir'|'file', rowEl, wrapperEl, expand? } — lets us reveal and
// select a file by path even though the tree loads children lazily.
const fileNodeMap = new Map()

// ── Files / Changes mode + viewer-pane diff state ─────────────────
// 'files' | 'changes' — which content #files-tree currently shows (see
// setFilesMode()/refreshChanges() below).
let filesMode = 'files'
// The active row in the Changes-mode list (a working-tree change or a
// commit's file) — mirrors activeFileRow's role for the file tree.
let activeChangeRow = null
// Identifies whatever diff is currently shown in the viewer pane, so
// Refresh (refreshWorkspacePane()) can re-fetch and re-render it:
// { type: 'working', path } | { type: 'commit', hash, path } | null.
let currentDiffRef = null

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', sql: 'sql',
  makefile: 'makefile', dockerfile: 'dockerfile',
  graphql: 'graphql', proto: 'protobuf',
}

function detectLanguage(filePath) {
  const name = filePath.split('/').pop().toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return name
  const ext = name.includes('.') ? name.split('.').pop() : ''
  return LANG_BY_EXT[ext] ?? null
}

// Highlight per-line rather than the whole file at once — hljs's HTML output
// can leave a span open across a newline, which would corrupt the markup if
// split afterward. Per-line loses a little context (e.g. multi-line strings
// may highlight inconsistently) but is simple and always well-formed, and each
// line becomes its own flex row so the line-number counter lines up exactly
// even when a long line wraps to multiple visual rows.
function renderHighlightedCode(text, language) {
  const canHighlight = language && typeof hljs !== 'undefined' && hljs.getLanguage(language)
  return text.split('\n').map(line => {
    let html
    try {
      html = canHighlight ? hljs.highlight(line, { language, ignoreIllegals: true }).value : escHtml(line)
    } catch {
      html = escHtml(line)
    }
    // hljs output for one line is often several sibling nodes (a span per
    // token, plus plain text runs between them) — dropped directly into
    // .code-line (a flex container), every one of those top-level nodes
    // becomes its own independent flex item that wraps on its own, breaking
    // continuous text flow apart wherever a line has more than one token
    // (e.g. an inline code span splits the line's text across two
    // independently-wrapping boxes). Wrapping them in one child element
    // keeps the whole line's content as a single flex item that wraps as
    // one continuous unit, like a plain-text line already does.
    return `<div class="code-line"><span class="code-content">${html}</span></div>`
  }).join('')
}

async function openFileInViewer(filePath, rowEl) {
  if (activeFileRow) activeFileRow.classList.remove('active')
  activeFileRow = rowEl
  if (rowEl) rowEl.classList.add('active')
  // Opening a plain file always supersedes whatever diff (if any) was showing.
  if (activeChangeRow) { activeChangeRow.classList.remove('active'); activeChangeRow = null }
  currentDiffRef = null

  currentViewerPath = filePath
  setViewerPathText(filePath)
  const toggleEl = $('file-viewer-toggle')

  const kind = window.ArgoPreview ? ArgoPreview.previewKindFor(filePath) : null
  // Show the preview/source toggle only for kinds that have both views.
  if (toggleEl) {
    const showToggle = !!(window.ArgoPreview && ArgoPreview.hasToggle(kind))
    toggleEl.classList.toggle('hidden', !showToggle)
    if (showToggle) {
      const mode = ArgoPreview.getMode(kind)
      toggleEl.querySelectorAll('.vt-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode)
      })
    }
  }

  await renderViewer(filePath, kind)
}

// Render the viewer body for a file, honoring the saved preview/source mode.
// Preview failures fall back to the guaranteed raw source view.
async function renderViewer(filePath, kind) {
  const contentEl = $('file-viewer-content')
  contentEl.classList.remove('file-viewer-empty', 'diff-view')
  // Images are preview-only; html/markdown honor the saved mode; everything
  // else is source.
  let mode = 'source'
  if (kind === 'image') mode = 'preview'
  else if (kind && window.ArgoPreview) mode = ArgoPreview.getMode(kind)

  if (mode === 'preview' && kind && window.ArgoPreview) {
    contentEl.classList.add('preview-mode')
    contentEl.innerHTML = ''
    try {
      await ArgoPreview.renderPreview({ filePath, kind, apiBase: API_BASE, container: contentEl, onNavigate: openFileByPath })
      return
    } catch {
      // Preview failed — fall through to the source view below.
    }
  }
  // Source view — existing behavior, and the guaranteed fallback.
  contentEl.classList.remove('preview-mode')
  contentEl.textContent = 'Loading…'
  try {
    const resp = await fetch(`${API_BASE}/file?path=${encodeURIComponent(filePath)}`)
    const text = await resp.text()
    contentEl.innerHTML = renderHighlightedCode(text, detectLanguage(filePath))
  } catch {
    contentEl.textContent = 'Failed to load file.'
  }
}

// Programmatic open used by preview navigation: reveal + select in the tree,
// then render in the viewer (row may be null if not found — still renders).
async function openFileByPath(filePath) {
  const rowEl = await selectFileInTree(filePath)
  await openFileInViewer(filePath, rowEl)
}

// Reveal and select a file by tree-relative path, expanding lazy ancestor
// directories in order. Returns the file's row element, or null on failure.
async function selectFileInTree(filePath) {
  const segs = String(filePath).split('/').filter(Boolean)
  let acc = ''
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? `${acc}/${segs[i]}` : segs[i]
    const node = fileNodeMap.get(acc)
    if (node && node.type === 'dir' && typeof node.expand === 'function') {
      try { await node.expand() } catch { /* ignore */ }
    } else {
      return null // ancestor missing — fail gracefully
    }
  }
  const target = fileNodeMap.get(filePath)
  if (!target || target.type !== 'file') return null
  if (activeFileRow) activeFileRow.classList.remove('active')
  activeFileRow = target.rowEl
  target.rowEl.classList.add('active')
  target.rowEl.scrollIntoView({ block: 'nearest' })
  return target.rowEl
}

// Sets #file-viewer-path's text — just the file's BASENAME (last path segment) —
// for whatever is currently shown — an open file (Files mode) or a diff (Changes
// mode). The full path is always available via the title tooltip.
function setViewerPathText(relPath) {
  const pathEl = $('file-viewer-path')
  if (!relPath) { pathEl.textContent = ''; pathEl.removeAttribute('title'); return }
  const full = `/${relPath}`
  pathEl.textContent = full.slice(full.lastIndexOf('/') + 1)
  pathEl.title = full
}

// Resets the viewer pane to its empty state and clears whichever selection (a file row
// in Files mode, or a change/commit-file row in Changes mode) was active. Shared by the
// close button and by setFilesMode() (switching modes retires whatever was shown).
function closeViewer() {
  if (activeFileRow) { activeFileRow.classList.remove('active'); activeFileRow = null }
  if (activeChangeRow) { activeChangeRow.classList.remove('active'); activeChangeRow = null }
  currentViewerPath = null
  currentDiffRef = null
  $('file-viewer-toggle').classList.add('hidden')
  setViewerPathText('')
  const contentEl = $('file-viewer-content')
  contentEl.classList.remove('preview-mode', 'diff-view')
  contentEl.textContent = 'Select a file to view'
  contentEl.classList.add('file-viewer-empty')
}
// Preview/source toggle — switch mode for the current file's kind and re-render.
$('file-viewer-toggle').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.vt-btn')
  if (!btn || !currentViewerPath) return
  const kind = window.ArgoPreview ? ArgoPreview.previewKindFor(currentViewerPath) : null
  if (!kind || !ArgoPreview.hasToggle(kind)) return
  const mode = btn.dataset.mode
  if (mode === ArgoPreview.getMode(kind)) return
  ArgoPreview.setMode(kind, mode)
  $('file-viewer-toggle').querySelectorAll('.vt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode)
  })
  renderViewer(currentViewerPath, kind)
})

$('refresh-files').addEventListener('click', refreshWorkspacePane)


// ── Nav init ─────────────────────────────────────────────────────
async function initNav() {
  // "Clear conversation" now lives in the combined indicator's dropdown (see
  // buildCtxDropdown) — the old standalone "＋" breadcrumb button is gone.

  // Workspace crumb — only in central/worker mode
  if (!window.__WS__) return

  $('nav-ws').style.display = 'inline-flex'
  $('ws-name-label').textContent = window.__WS__

  const navWs = $('nav-ws')
  const wsBtn = $('ws-btn')

  wsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasOpen = navWs.classList.contains('open')
    closeAllDropdowns()
    if (!wasOpen) {
      navWs.classList.add('open')
      const r = wsBtn.getBoundingClientRect()
      wsDropdown.style.top  = (r.bottom + 6) + 'px'
      wsDropdown.style.left = r.left + 'px'
    }
  })

  // Build workspace dropdown — just the workspace list (current + others,
  // no separators between them), then a single separator and a trailing
  // "Attach another workspace…" item that hands off to the home screen (the
  // inline attach-a-folder form that used to live here is gone).
  const wsDropdown = $('ws-dropdown')
  wsDropdown.innerHTML = ''

  const wsLabel = document.createElement('div')
  wsLabel.className = 'nav-drop-label'
  wsLabel.textContent = 'Workspaces'
  wsDropdown.appendChild(wsLabel)

  // Current workspace row with detach button
  const currWs = document.createElement('div')
  currWs.className = 'nav-drop-item active'
  currWs.innerHTML = `<span class="drop-dot">●</span><span>${escHtml(window.__WS__)}</span><button class="nav-drop-detach" type="button">Detach</button>`
  const currDetach = currWs.querySelector('.nav-drop-detach')
  currDetach.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!(await confirmDialog(`Detach "${window.__WS__}" and stop its container?`))) return
    const overlay = showDetachOverlay(window.__WS__)
    currDetach.innerHTML = '<span class="ui-spinner gap"></span>Detaching…'
    currDetach.disabled = true
    currDetach.classList.add('detaching')
    try {
      const resp = await fetch(`/api/detach/${window.__WS__}`, { method: 'POST' })
      if (!resp.ok) throw new Error('Detach failed')
      window.location.href = '/'
    } catch (err) {
      overlay.remove()
      currDetach.textContent = 'Detach'
      currDetach.disabled = false
      currDetach.classList.remove('detaching')
      showToast(err.message || 'Failed to detach workspace')
    }
  })
  wsDropdown.appendChild(currWs)

  // Placeholder for other running workspaces (filled by API)
  const othersContainer = document.createElement('div')
  wsDropdown.appendChild(othersContainer)

  // Populate other workspaces from API (best-effort) — includes stopped ones,
  // which get started on click rather than being unreachable from here.
  try {
    const workspaces = await fetch('/api/workspaces').then(r => r.json())
    const others = workspaces.filter(w => w.name !== window.__WS__)
    if (others.length > 0) {
      others.forEach(w => {
        const row = document.createElement('div')
        row.className = 'nav-drop-item'
        const dotClass = w.running ? 'drop-dot' : 'drop-dot stopped'
        row.innerHTML = `<span class="${dotClass}">●</span><span class="drop-text">${escHtml(w.name)}</span><button class="nav-drop-detach" type="button">Detach</button>`
        row.addEventListener('click', async () => {
          if (w.running) { window.location.href = `/ws/${w.name}/`; return }
          row.querySelector('.drop-text').textContent = 'Starting…'
          try {
            const resp = await fetch('/api/attach', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: w.path }),
            })
            const data = await resp.json()
            if (!resp.ok) throw new Error(data.error)
            window.location.href = data.url
          } catch (err) {
            row.querySelector('.drop-text').textContent = w.name
            showToast(err.message || 'Failed to start workspace')
          }
        })
        const detachBtn = row.querySelector('.nav-drop-detach')
        detachBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          if (!(await confirmDialog(`Detach "${w.name}" and stop its container?`))) return
          detachBtn.innerHTML = '<span class="ui-spinner gap"></span>Detaching…'
          detachBtn.disabled = true
          detachBtn.classList.add('detaching')
          try {
            const resp = await fetch(`/api/detach/${w.name}`, { method: 'POST' })
            if (!resp.ok) throw new Error('Detach failed')
            row.remove()
          } catch (err) {
            detachBtn.textContent = 'Detach'
            detachBtn.disabled = false
            detachBtn.classList.remove('detaching')
            showToast(err.message || 'Failed to detach workspace')
          }
        })
        othersContainer.appendChild(row)
      })
    }
  } catch { /* standalone dev — no workspace API */ }

  // Trailing "Attach another workspace…" item — the only separator in this
  // dropdown sits directly above it, setting it apart from the workspace
  // list above.
  const sepAttach = document.createElement('div')
  sepAttach.className = 'nav-drop-sep'
  wsDropdown.appendChild(sepAttach)

  const attachAnotherRow = document.createElement('div')
  attachAnotherRow.className = 'nav-drop-item'
  attachAnotherRow.innerHTML = `<span>Attach another workspace…</span>`
  attachAnotherRow.addEventListener('click', () => { window.location.href = '/' })
  wsDropdown.appendChild(attachAnotherRow)
}

// ── Init ─────────────────────────────────────────────────────────




function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDate(iso) {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.floor((now - d) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

// Replays the live session's persisted events on page load, so a refresh — even
// mid-run, even after time with no UI connected (the agent keeps persisting to
// its JSONL regardless) — restores the full conversation and trace. The
// replay/live boundary is handled by boot(): `replaying` is true on load, so
// live SSE events are buffered and flushed once this replay completes.
async function loadHistory() {
  if (!currentLiveSessionId) return
  try {
    const sessions = await fetch(`${API_BASE}/logs`).then(r => r.json()).catch(() => [])
    const live = Array.isArray(sessions) ? sessions.find(s => s.id === currentLiveSessionId) : null
    liveRunMaxSeq = await replaySessionRuns(live?.runs ?? [])
  } catch { /* no events yet */ }
}

// ── Panel resize ─────────────────────────────────────────────────
function initResize(handleId, getWidth, cssVar, minPx) {
  const handle = $(handleId)
  if (!handle) return
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    handle.classList.add('dragging')
    const startX = e.clientX
    const startW = getWidth()
    const onMove = (ev) => {
      const w = Math.max(minPx, startW + ev.clientX - startX)
      document.documentElement.style.setProperty(cssVar, w + 'px')
    }
    const onUp = () => {
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

// ── Workspace gate (standalone mode only — central/worker always has one) ──
function showNoWorkspaceScreen() {
  // Both column toolbars now live inside <main> (#chat-panel/#files-panel),
  // so hiding main alone hides everything the old standalone <header> did.
  document.querySelector('main').classList.add('hidden')
  $('no-workspace-screen').classList.remove('hidden')
}

function showEnvBanner(env) {
  if (!env) return
  const missing = []
  if (!env.ollama) missing.push('Ollama is not running')
  if (!env.docker) missing.push('Docker is not running')
  if (!env.git) missing.push('git was not found')
  if (missing.length === 0) return
  $('env-banner').textContent = `⚠ ${missing.join(' · ')}`
  $('env-banner').classList.remove('hidden')
}

$('no-workspace-btn').addEventListener('click', async () => {
  const input = $('no-workspace-path')
  const btn = $('no-workspace-btn')
  const errEl = $('no-workspace-error')
  const p = input.value.trim()
  if (!p) return
  btn.disabled = true
  errEl.textContent = ''
  try {
    const resp = await fetch(`${API_BASE}/api/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    })
    const data = await resp.json()
    if (!resp.ok) { errEl.textContent = data.error || 'Failed to mount folder'; btn.disabled = false; return }
    location.reload()
  } catch {
    errEl.textContent = 'Failed to reach Argo server'
    btn.disabled = false
  }
})
$('no-workspace-path').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('no-workspace-btn').click()
})

async function boot() {
  const status = await fetch(`${API_BASE}/status`).then(r => r.json()).catch(() => ({}))
  showEnvBanner(status.env)
  if (!window.__WS__ && !status.workspacePath) { showNoWorkspaceScreen(); finishReplay(); return }

  // Multi-agent architecture (config.agents): the grounding toggle isn't wired to
  // dispatch.ts's frames yet — hide it rather than show a control that would
  // silently do nothing, same principle as everywhere else in this UI.
  const groundingSetting = document.querySelector('.setting-grounding')
  if (groundingSetting) groundingSetting.classList.toggle('hidden', !!status.agents)

  // Draw an empty donut immediately (visible before the first token_usage).
  renderDonut()

  // Auto-commit defaults OFF; restore whatever the worker currently has set.
  autoCommit = !!status.autoCommit
  syncAutoCommitUI()

  currentLiveSessionId = status.sessionId ?? ''
  // await so the model dropdown is populated (and its models[0] default selected)
  // BEFORE the history replay below runs applySessionSettings() — otherwise
  // loadModels' own selection could land last and clobber the restored sticky model.
  await loadModels()
  refreshGitLog()
  // Drop the static index.html placeholder before replaying; the empty-session
  // placeholder is re-added below.
  messagesEl.innerHTML = ''
  // Replay persisted events first, THEN open the replay/live boundary: `replaying`
  // is true from module load so any live SSE events that arrived meanwhile are
  // buffered, and finishReplay() renders them (deduped) once the replay is done.
  await loadHistory()
  finishReplay()
  // Restore the running state on reload — otherwise, mid-run, the UI acts as if idle
  // (input, send/stop button, status dot) even though the agent is still working.
  if (status.busy) {
    setBusy(true)
    setStatus('busy', `Running · ${currentRunModel || status.model || ''}`)
  }
  if (!messagesEl.children.length) {
    messagesEl.innerHTML = '<div class="message system">Session started. Ask anything.</div>'
  }
  initNav()
  refreshFiles()
  initResize('panel-resize', () => $('chat-panel').getBoundingClientRect().width, '--chat-width', 240)
  initResize('tree-resize', () => $('file-tree-pane').getBoundingClientRect().width, '--tree-width', 120)
}

boot()
