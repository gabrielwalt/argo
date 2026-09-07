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
// Latest context size the model saw, plus the fraction at which auto-compaction
// fires (fetched once from /status on boot). The donut's ring+tick are drawn
// from these and redrawn on every token_usage; precise numbers live in the
// dropdown. The donut's CENTER communicates agent state (see indicatorState).
// frameId/role: null for the baseline agent's own token_usage (untagged events,
// the pre-multi-agent path); set to the owning frame's identity when the reading
// came from a frame-tagged token_usage instead (see handleEvent), so the dropdown
// can always say WHOSE numbers it's showing rather than an unattributed count.
let ctxState = { promptTokens: 0, numCtx: 0, pct: 0, frameId: null, role: null }
let compactThreshold = 0.667
// True while a user-triggered /compact-now is in flight — used to (a) disable the
// dropdown/modal action and (b) let compaction trace events render even when
// they'd otherwise be suppressed (e.g. while viewing a past session).
let manualCompacting = false

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
// Deprecated fields from the old LLM-summarization compaction's progress reporting
// (no longer emitted — deterministic eviction has no multi-step sub-calls to report
// progress on). Left in place only because the "Compacting…" status label formatter
// still reads them defensively; always null in the current harness.
let compactElapsedS = null
let compactTimeoutS = null
let compactStep = null
let lastCompactionDurationS = null

// Arc color mirrors the old ctx-ok/ctx-warn/ctx-danger thresholds, read from the
// same CSS custom properties so the palette stays in one place (styles.css).
function ctxArcColor(pct) {
  const root = getComputedStyle(document.documentElement)
  if (pct >= 90) return root.getPropertyValue('--red').trim()
  if (pct >= 70) return root.getPropertyValue('--yellow').trim()
  return root.getPropertyValue('--muted').trim()
}

function renderDonut() {
  const size = 24, cx = 12, cy = 12, r = 8, sw = 3
  const pct = Math.max(0, Math.min(100, ctxState.pct))
  const circ = 2 * Math.PI * r
  const dash = circ * (pct / 100)
  const color = ctxArcColor(pct)
  // Threshold tick at the compaction trigger. Compaction now fires when only ~4096 tokens of
  // headroom remain (COMPACT_RESERVE_TOKENS), so the tick sits at (numCtx-reserve)/numCtx; fall
  // back to the old fraction before the first token_usage. Angle from 12 o'clock (−90° SVG).
  const thrFrac = ctxState.numCtx ? Math.max(0, 1 - 4096 / ctxState.numCtx) : compactThreshold
  const ang = thrFrac * 2 * Math.PI - Math.PI / 2
  const rIn = r - sw / 2 - 1, rOut = r + sw / 2 + 1
  const tx1 = (cx + rIn * Math.cos(ang)).toFixed(2), ty1 = (cy + rIn * Math.sin(ang)).toFixed(2)
  const tx2 = (cx + rOut * Math.cos(ang)).toFixed(2), ty2 = (cy + rOut * Math.sin(ang)).toFixed(2)

  // Core: solid state color, filling the middle of the ring. Glows to match the state
  // color (same "shiny" treatment as the home screen's status dot) and pulses gently
  // while busy/compacting; steady (just the glow) while ready/idle.
  const coreColor = { ready: 'var(--green)', busy: 'var(--yellow)', compacting: 'var(--purple)', error: 'var(--red)' }[indicatorState] || 'var(--green)'
  const coreClass = indicatorState === 'compacting' ? 'ctx-core compacting'
    : indicatorState === 'busy' ? 'ctx-core running'
    : 'ctx-core'
  const coreR = r - sw / 2 - 2.5

  tokenCounter.innerHTML =
    `<svg class="ctx-donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"`
    + ` stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
    + `<line class="ctx-tick" x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="var(--text)" stroke-width="1.5"/>`
    + `<circle class="${coreClass}" cx="${cx}" cy="${cy}" r="${coreR.toFixed(2)}" fill="${coreColor}" style="filter: drop-shadow(0 0 3px ${coreColor})"/>`
    + `</svg>`
}

// Update stored context size + redraw. Precise numbers show in the dropdown;
// the donut itself only ever shows the ring (usage), tick (threshold) and
// core+center-text (agent state / iteration). frameId/role identify which
// agent this reading belongs to (see ctxState above); omitted for the baseline.
function updateCtx(promptTokens, numCtx, frameId = null, role = null) {
  const pct = numCtx ? Math.round(promptTokens / numCtx * 100) : 0
  ctxState = { promptTokens, numCtx, pct, frameId, role }
  renderDonut()
}

// Compact k-token formatting for the dropdown's frame-owned reading, where the
// role name added ahead of it (see buildCtxDropdown) eats into the available
// width — the baseline reading keeps the original full toLocaleString() format.
function fmtTokensK(n) {
  if (n == null) return '—'
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
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
let currentTraceBlock = null
let traceToolCalls = 0
let traceStartTime = null
// Latest iteration number of the CURRENT trace block — drives the collapsed
// title while running (see addIterationSeparator()).
let latestIteration = null

// ── Collapsed "current activity" pacing ─────────────────────────
// Trace items append the instant their SSE event arrives, so a fast run's
// collapsed one-line summary would otherwise flicker through several lines a
// second. Queue surfaced lines instead: each one stays on screen for at
// least ACTIVITY_MIN_MS before the next queued one takes over. Nothing is
// ever dropped — a burst just drains at a readable pace, a little behind
// live (the expanded trace below still has every item, instantly, in order).
const ACTIVITY_MIN_MS = 5000
let activityQueue = []
let activityTimer = null

function surfaceActivity(text) {
  if (!currentTraceBlock) return
  activityQueue.push(text)
  pumpActivityQueue()
}

function pumpActivityQueue() {
  if (activityTimer || !currentTraceBlock || !activityQueue.length) return
  currentTraceBlock.subtitle.textContent = activityQueue.shift()
  activityTimer = setTimeout(() => {
    activityTimer = null
    pumpActivityQueue()
  }, ACTIVITY_MIN_MS)
}

function clearActivityQueue() {
  activityQueue = []
  clearTimeout(activityTimer)
  activityTimer = null
}

// One line, no newlines — for the collapsed activity subtitle only; the full
// text still goes into the expanded trace item body untouched.
function summarize(text, max = 90) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

function startTraceBlock(model) {
  traceToolCalls = 0
  traceStartTime = Date.now()
  latestIteration = null
  clearActivityQueue()
  // Multi-agent architecture (config.agents): each top-level run starts with a clean
  // slate of role cards — frameIds are unique per run, but nothing should ever look
  // up a PRIOR run's card by accident.
  roleCards.clear()

  const block = document.createElement('div')
  block.className = 'trace-block running'

  const toggle = document.createElement('div')
  toggle.className = 'trace-block-toggle'

  const arrow = document.createElement('span')
  arrow.className = 'trace-block-arrow'
  arrow.textContent = '▶'

  const titleWrap = document.createElement('div')
  titleWrap.className = 'trace-block-title-wrap'

  const title = document.createElement('span')
  title.className = 'trace-block-title'
  title.textContent = `Running · ${model}`

  const subtitle = document.createElement('span')
  subtitle.className = 'trace-block-subtitle'

  titleWrap.append(title, subtitle)

  const meta = document.createElement('span')
  meta.className = 'trace-block-meta'

  toggle.append(arrow, titleWrap, meta)
  toggle.addEventListener('click', () => {
    block.classList.toggle('open')
    arrow.textContent = block.classList.contains('open') ? '▼' : '▶'
  })

  const items = document.createElement('div')
  items.className = 'trace-block-items'

  block.append(toggle, items)
  messagesEl.appendChild(block)
  maybeAutoScroll()

  currentTraceBlock = { el: block, items, title, subtitle, meta, arrow }
}

function finalizeTraceBlock() {
  if (!currentTraceBlock) return
  const dur = traceStartTime ? ((Date.now() - traceStartTime) / 1000).toFixed(1) : ''
  currentTraceBlock.title.textContent = 'Agent trace'
  currentTraceBlock.subtitle.textContent = ''
  currentTraceBlock.meta.textContent = `${traceToolCalls} tool${traceToolCalls !== 1 ? 's' : ''} · ${dur}s`
  currentTraceBlock.el.classList.remove('running')
  clearActivityQueue()
  currentTraceBlock = null
}

// Bold full-width divider marking a new iteration — a structural break in
// the trace, not another event row (no label/body chrome, no left edge to
// match). Also drives the collapsed title while running: "Iteration N" so
// glancing at a collapsed block shows how far the run has gotten, instead of
// a static "Running · model".
function addIterationSeparator(n) {
  latestIteration = n
  if (!currentTraceBlock) return null
  const el = document.createElement('div')
  el.className = 'trace-separator'
  el.innerHTML = `<span class="trace-separator-line"></span><span class="trace-separator-label">Iteration ${n}</span><span class="trace-separator-line"></span>`
  currentTraceBlock.items.appendChild(el)
  if (currentTraceBlock.el.classList.contains('running')) {
    currentTraceBlock.title.textContent = `Iteration ${n}`
  }
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
  // Multi-agent architecture (config.agents): a tagged event belongs to one frame's
  // turn, not the top-level run — route it into that frame's role card instead of
  // the switch below. Also nudges the status bar to name the active role, the
  // "boss-level" glance the multi-agent UI is built around.
  if (event.__frameId) {
    // token_usage is handled HERE, before the routing below, and deliberately not
    // inside handleFrameEvent: in multi-agent mode the baseline agent is bypassed
    // (see CONTEXT-VIEWER-CONTRACT.md) and never emits its own token_usage, so the
    // donut would otherwise sit frozen near-zero regardless of what the frames are
    // actually doing. The per-frame Agent instances are the only ones that ever
    // call the model, so the donut has to read straight off whichever frame's
    // token_usage just arrived. This does NOT skip the routing below — it falls
    // through to handleFrameEvent()/the early return exactly as before, since
    // token_usage has no role-card representation of its own (see the comment at
    // the bottom of handleFrameEvent).
    if (event.type === 'token_usage') updateCtx(event.prompt_tokens, event.num_ctx, event.__frameId, event.__role)
    handleFrameEvent(event)
    if (event.type === 'start') {
      const meta = ROLE_META[event.__role] || { name: event.__role, title: event.__role }
      setStatus('busy', `Running · ${meta.name} (${meta.title})`)
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
      addTraceItem('thought', '💭 Thought', event.content, true)
      surfaceActivity(`💭 ${summarize(event.content)}`)
      break

    case 'tool_call':
      traceToolCalls++
      addTraceItem('tool-call', `🔧 ${event.tool}`, JSON.stringify(event.args, null, 2), true)
      surfaceActivity(`🔧 ${event.tool}`)
      break

    case 'tool_result': {
      const isError = !!event.error
      const label = `📥 Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addTraceItem(isError ? 'tool-result error' : 'tool-result', label, body, true)
      surfaceActivity(isError ? `📥 ${event.tool || 'tool'} failed` : `📥 ${event.tool || 'result'} received`)
      // Live-update the file tree + the viewed file when the agent may have changed files.
      if (!isError && (event.tool === 'write_file' || event.tool === 'edit_file' || event.tool === 'bash')) {
        scheduleWorkspaceRefresh()
      }
      break
    }

    case 'message':
      if (event.role === 'assistant') {
        addChatMessage('assistant', event.content)
      }
      break

    case 'token_usage':
      updateCtx(event.prompt_tokens, event.num_ctx)
      break

    case 'done': {
      // Capture the user-stop flag before setBusy(false) resets stopRequested.
      const wasStopped = stopRequested
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
      // A manually triggered compaction (see the indicator dropdown / context
      // viewer's "Compact now") has no run following it to eventually fire
      // 'done' and restore status — reflect that here instead of leaving the
      // dot/indicator stuck on "Running"/"Compacting".
      compactingNow = false
      if (compactStartTime) {
        lastCompactionDurationS = Math.round((Date.now() - compactStartTime) / 1000)
        compactStartTime = null
      }
      if (event.manual) setStatus('ready', 'Ready')
      else setStatus('busy', `Running · ${currentRunModel}`)
      addTraceItem('compact', `⚡ Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      surfaceActivity('⚡ Context compacted')
      // A user-triggered manual compaction (no run to fire 'done') finalizes its
      // own trace block here; an in-run auto-compaction leaves the block open for
      // the run to keep filling. The donut's ring keeps showing the last known size.
      if (manualCompacting) {
        finalizeTraceBlock()
        manualCompacting = false
      }
      break

    case 'warning':
      addTraceItem('warning', '⚠ Warning', event.message, false)
      surfaceActivity(`⚠ ${summarize(event.message)}`)
      break

    case 'git_commit':
      addTraceItem('git', `🔀 Committed`, `${event.hash} — ${event.message}`, false)
      surfaceActivity('🔀 Committed')
      refreshGitLog()
      // The new commit + cleared working changes only matter to Changes mode.
      refreshChangesIfActive()
      break

    case 'error':
      addTraceItem('error-item', '⚠ Error', event.message, false)
      compactingNow = false
      setStatus('error', 'Error')
      finalizeTraceBlock()
      setBusy(false)
      confirmRunEnded()
      break
  }
}

// Renders one PERSISTED (replayed) event into the trace/chat. Reuses the same
// DOM helpers as the live path for identical visual output, but omits every
// live-only side effect (status bar, busy state, git/file refreshes, iteration
// and token counters — those reflect a *running* agent, not history). Unlike the
// live path it also renders user messages: on replay there is no submit handler
// to have added them optimistically. ollama_request / token_usage are live-only
// telemetry with nothing to draw into the trace.
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
      addTraceItem('thought', '💭 Thought', event.content, true)
      break

    case 'tool_call':
      traceToolCalls++
      addTraceItem('tool-call', `🔧 ${event.tool}`, JSON.stringify(event.args, null, 2), true)
      break

    case 'tool_result': {
      const isError = !!event.error
      const label = `📥 Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addTraceItem(isError ? 'tool-result error' : 'tool-result', label, body, true)
      break
    }

    case 'message':
      addChatMessage(event.role, event.content)
      break

    case 'compact':
      addTraceItem('compact', `⚡ Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      break

    case 'warning':
      addTraceItem('warning', '⚠ Warning', event.message, false)
      break

    case 'git_commit':
      addTraceItem('git', `🔀 Committed`, `${event.hash} — ${event.message}`, false)
      break

    case 'done':
      finalizeTraceBlock()
      break

    case 'error':
      addTraceItem('error-item', '⚠ Error', event.message, false)
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
// free. "Compact now" lives in the context viewer's title bar instead of
// here (see viewContext()).
const navCtx = $('nav-ctx')
const ctxDropdown = $('ctx-dropdown')

function compactStatusText() {
  if (indicatorState === 'compacting') {
    if (compactElapsedS != null) {
      return `Compacting…${compactStep ? ' ' + compactStep : ''} (${compactElapsedS}s / ${compactTimeoutS}s)`
    }
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
    // in handleEvent(). The baseline (ctxState.role === null) keeps the original
    // precise format unchanged.
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

// Manual compaction. Disabled in the UI while busy/in-flight, but guard anyway.
// Ensures a trace block exists so the 'compact' event has somewhere to render;
// that event (see handleEvent) finalizes the block on completion.
async function compactNow() {
  if (busy || manualCompacting) return
  manualCompacting = true
  const createdBlock = !currentTraceBlock
  if (createdBlock) startTraceBlock('manual compaction')
  try {
    const resp = await fetch(`${API_BASE}/compact-now`, { method: 'POST' })
    if (resp.status === 409) {
      showToast('Agent is finishing the previous run — try again in a moment')
      cleanupManualCompaction(createdBlock)
      return
    }
    const result = await resp.json()
    if (!resp.ok) {
      showToast(result.error || 'Failed to compact')
      cleanupManualCompaction(createdBlock)
      return
    }
    if (!result.compacted) {
      showToast('Nothing to compact yet')
      cleanupManualCompaction(createdBlock)
      return
    }
    // Success: the 'compact' event renders into the trace and finalizes the
    // block (see handleEvent). Nothing more to do here.
  } catch {
    showToast('Failed to compact')
    cleanupManualCompaction(createdBlock)
  }
}

// Tear down after a manual compaction that produced no trace: drop the empty
// block we created (no dangling "0 tools" block), else finalize it.
function cleanupManualCompaction(createdBlock) {
  if (createdBlock && currentTraceBlock) {
    if (currentTraceBlock.items.childElementCount === 0) {
      currentTraceBlock.el.remove()
      clearActivityQueue()
      currentTraceBlock = null
    } else {
      finalizeTraceBlock()
    }
  }
  manualCompacting = false
}

// ── Frame-aware context viewer ──────────────────────────────────────
// GET /frames lists every frame of the current session (see CONTEXT-VIEWER-CONTRACT.md);
// GET /context?frame=<id> loads one of them, GET /context with no param is still the
// baseline agent (bypassed entirely in multi-agent mode — see renderContext()). /frames
// is the newer of the two routes, so it may 404 if this half of the feature isn't deployed
// yet on the running server; ctxFramesData stays null in that case and the viewer falls
// back to the single-context view it always had.
let ctxFramesData = null       // last /frames response, or null when the route is unavailable
let ctxSelectedFrame = null    // frameId currently shown in #diff-content, or null for the baseline

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
// totalChars (the one actually worth reading) — falling back to the baseline when there
// are no frames at all yet (a fresh session, or agents mode simply off).
function pickDefaultFrame(framesData) {
  if (framesData.active) return framesData.active
  const frames = framesData.frames || []
  if (!frames.length) return null
  let best = frames[0]
  for (const f of frames) if ((f.totalChars ?? 0) > (best.totalChars ?? 0)) best = f
  return best.frameId
}

function baselineOptionLabel(baselineBypassed) {
  return baselineBypassed
    ? '⏸ Baseline agent — bypassed in multi-agent mode'
    : '🧵 Baseline agent (single-loop)'
}

// Reuses ROLE_META (the same names/icons the role cards use) rather than inventing a
// second vocabulary for the same four roles.
function frameOptionLabel(f) {
  const meta = ROLE_META[f.role] || { icon: '🤖', title: f.role }
  return `${meta.icon} ${meta.title} (${f.frameId}) · ${(f.totalChars ?? 0).toLocaleString()} chars${f.live ? ' · live' : ''}`
}

// Rebuilds the selector from ctxFramesData — or, when it's null (no /frames route),
// drops the select entirely and shows a plain explanatory line instead.
function renderCtxFrameBar() {
  ctxFrameBar.classList.remove('hidden')
  if (!ctxFramesData) {
    ctxFrameBar.classList.add('note-only')
    ctxFrameHint.textContent = 'Per-frame inspection needs a server restart — showing the baseline context only.'
    return
  }
  ctxFrameBar.classList.remove('note-only')
  ctxFrameHint.textContent = ''
  ctxFrameSelect.innerHTML = ''
  const baseOpt = document.createElement('option')
  baseOpt.value = ''
  baseOpt.textContent = baselineOptionLabel(ctxFramesData.baselineBypassed)
  ctxFrameSelect.appendChild(baseOpt)
  for (const f of ctxFramesData.frames || []) {
    const opt = document.createElement('option')
    opt.value = f.frameId
    opt.textContent = frameOptionLabel(f)
    ctxFrameSelect.appendChild(opt)
  }
  ctxFrameSelect.value = ctxSelectedFrame ?? ''
}

// "Compact now" acts on the baseline agent only (src/server.ts's /compact-now targets
// the single baseline Agent instance) — never offer it for a frame it cannot act on, or
// for a bypassed baseline that has nothing to compact. Always visible, disabled with an
// explanatory title rather than hidden, so it doesn't look like a button that silently
// does nothing.
function updateCompactBtnState(data) {
  diffCompactBtn.classList.remove('hidden')
  const isBaseline = ctxSelectedFrame == null
  if (!isBaseline) {
    diffCompactBtn.disabled = true
    diffCompactBtn.title = 'Compact now only acts on the baseline agent — select it above to use it'
  } else if (data.baselineBypassed) {
    diffCompactBtn.disabled = true
    diffCompactBtn.title = 'Baseline agent is bypassed in multi-agent mode — nothing to compact'
  } else {
    diffCompactBtn.disabled = busy || manualCompacting
    diffCompactBtn.title = 'Compact context now'
  }
  diffCompactBtn.textContent = '⚡ Compact now'
}

// Loads one frame's context (or the baseline's, when frameId is null) into the already-open
// modal. Shared by viewContext() (initial load) and the selector's change handler / the
// "Compact now" refresh (neither of which should re-fetch /frames or re-pick a default).
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
  // Title names the owner (never a bare, unattributed count) but keeps the bypass
  // explanation itself inside the body (renderContext) rather than repeating it here.
  const meta = data.role ? (ROLE_META[data.role] || { title: data.role, icon: '🤖' }) : null
  const owner = meta ? `${meta.icon} ${meta.title}` : '🧵 Baseline agent'
  diffTitle.textContent = `${owner} — Context (${data.messageCount ?? 0} messages · ${(data.totalChars ?? 0).toLocaleString()} chars · num_ctx ${(data.numCtx ?? 0).toLocaleString()})`
  diffContent.innerHTML = renderContext(data)
  updateCompactBtnState(data)
}

ctxFrameSelect.addEventListener('change', () => {
  loadFrameContext(ctxFrameSelect.value || null)
})

// View the exact context the model currently sees. Read-only; reuses #diff-modal. The
// modal's title bar carries a "Compact now" action (replacing the old dropdown item);
// see updateCompactBtnState() for when it's actually enabled.
async function viewContext() {
  diffTitle.textContent = 'Context'
  diffContent.textContent = 'Loading…'
  diffCompactBtn.classList.add('hidden')
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
  // The baseline is bypassed entirely in multi-agent mode (never accumulates history) —
  // say so plainly instead of letting an empty context read as a bug (see
  // CONTEXT-VIEWER-CONTRACT.md). Only applies to the baseline (frameId == null); a frame
  // that is genuinely empty (e.g. spawned but never ran) still falls through to the
  // ordinary "(empty context)" fallback below.
  if (data.frameId == null && data.baselineBypassed) {
    html += '<div class="ctx-msg ctx-bypassed"><div class="ctx-content">⏸ Baseline loop — bypassed in multi-agent mode. It never ran this session, so there is nothing here to show. Select a frame above to see what the agents actually did.</div></div>'
  }
  // Right-aligned wall-clock time (when the message entered the model context, from the
  // backend WeakMap via getContext). Omitted when unknown (e.g. messages restored from disk).
  const timeTag = (ts) => ts != null ? `<span class="ctx-time">${escHtml(new Date(ts).toLocaleTimeString())}</span>` : ''
  if (data.compaction != null) {
    const c = data.compaction
    const text = typeof c === 'string' ? c : JSON.stringify(c, null, 2)
    html += `<div class="ctx-msg ctx-ledger"><div class="ctx-role"><span>Compaction ledger</span>${timeTag(data.compactionTs)}</div><div class="ctx-content">${escHtml(text)}</div></div>`
  }
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

// `container` defaults to the top-level trace block's own item list, but a role
// card (see below) passes its OWN nested items list so the same rendering logic
// (label/body/expand-on-long-text) works identically whether an event belongs to
// the top-level run or to one specific agent's turn inside it.
function addTraceItem(className, label, body, collapsible, container) {
  const target = container || (currentTraceBlock && currentTraceBlock.items)
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

// ── Multi-agent architecture (config.agents) — nested role cards ─────────────────
// Every event a spawned frame produces (thought/tool_call/plan/done/...) arrives
// tagged with __frameId/__role/__parentFrameId (see types.ts's FrameTag); an
// untagged event is the top-level dispatch narrative, rendered exactly like the
// single-loop baseline (unchanged code path below). A tagged event instead nests
// inside a small collapsible "role card" for that one frame's turn — one flat,
// chronological sequence inside the SAME top-level trace block, since dispatch
// is strictly sequential (docs/subagents-plan.md's hard no-parallelism rule), so
// execution order alone already shows which agent ran after which.
//
// Display names are a presentation-only layer over the plain functional role —
// see frames.ts's ROLE_NAME for the same mapping, chosen for an actual functional
// match rather than flavor alone.
const ROLE_META = {
  boss:        { name: 'Boss',         title: 'Boss',        icon: '⚖️' },
  planner:     { name: 'Planner',     title: 'Planner',     icon: '🧭' },
  implementer: { name: 'Implementer', title: 'Implementer', icon: '🔨' },
}

// frameId -> { el, arrow, items, outcome, hasItems }. Cleared per top-level run
// (startTraceBlock) — see there for why stale entries can't leak across runs.
const roleCards = new Map()

// Gets the card for an already-known frameId (a RESUMED frame — the Planner's next
// detail call reuses its existing card rather than creating a confusing duplicate),
// or creates a fresh one.
function getOrCreateRoleCard(frameId, role, assignment) {
  const existing = roleCards.get(frameId)
  if (existing) {
    existing.el.classList.add('active')
    return existing
  }
  const meta = ROLE_META[role] || { name: role, title: role, icon: '🤖' }

  const card = document.createElement('div')
  card.className = 'role-card active'

  const toggle = document.createElement('div')
  toggle.className = 'role-card-toggle'

  const arrow = document.createElement('span')
  arrow.className = 'role-card-arrow'
  // No expand affordance until this frame actually accumulates a nested item —
  // a one-shot answer with nothing else to show gets no arrow at all.

  const titleWrap = document.createElement('div')
  titleWrap.className = 'role-card-title-wrap'
  const title = document.createElement('span')
  title.className = 'role-card-title'
  title.textContent = `${meta.icon} ${meta.name} · ${meta.title}`
  const subtitle = document.createElement('span')
  subtitle.className = 'role-card-subtitle'
  subtitle.textContent = summarize(assignment, 120)
  titleWrap.append(title, subtitle)

  const outcome = document.createElement('span')
  outcome.className = 'role-card-outcome'

  toggle.append(arrow, titleWrap, outcome)
  toggle.addEventListener('click', () => {
    if (!card.classList.contains('expandable')) return
    card.classList.toggle('open')
    arrow.textContent = card.classList.contains('open') ? '▼' : '▶'
  })

  const items = document.createElement('div')
  items.className = 'role-card-items'

  card.append(toggle, items)
  if (!currentTraceBlock) startTraceBlock(currentRunModel)
  currentTraceBlock.items.appendChild(card)
  maybeAutoScroll()

  const record = { el: card, arrow, items, outcome, hasItems: false }
  roleCards.set(frameId, record)
  return record
}

function addRoleCardItem(frameId, className, label, body, collapsible) {
  const card = roleCards.get(frameId)
  if (!card) return
  if (!card.hasItems) {
    card.hasItems = true
    card.el.classList.add('expandable')
    card.arrow.textContent = '▶'
  }
  addTraceItem(className, label, body, collapsible, card.items)
}

// Closes out a frame's card with its one-line outcome — a SYNTHESIS (short status +
// summary), never the raw text again: the raw final answer already appeared as this
// same frame's last nested item (its own 'thought'/'message'), so repeating it here
// would just duplicate what expanding the card already shows.
function closeRoleCard(frameId, outcomeText) {
  const card = roleCards.get(frameId)
  if (!card) return
  card.outcome.textContent = outcomeText
  card.el.classList.remove('active')
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
      addRoleCardItem(frameId, 'thought', '💭 Thought', event.content, true)
      break
    case 'tool_call':
      addRoleCardItem(frameId, 'tool-call', `🔧 ${event.tool}`, JSON.stringify(event.args, null, 2), true)
      break
    case 'tool_result': {
      const isError = !!event.error
      const label = `📥 Result${event.error ? ' · ERROR' : ''} · ${event.duration_ms}ms`
      const body = event.error ? `${event.error}\n${event.output}` : event.output
      addRoleCardItem(frameId, isError ? 'tool-result error' : 'tool-result', label, body, true)
      break
    }
    case 'warning':
      addRoleCardItem(frameId, 'warning', '⚠ Warning', event.message, false)
      break
    case 'compact':
      addRoleCardItem(frameId, 'compact', `⚡ Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}`, true)
      break
    case 'git_commit':
      addRoleCardItem(frameId, 'git', '🔀 Committed', `${event.hash} — ${event.message}`, false)
      break
    case 'message':
      // Swallowed deliberately — this frame's final answer is already captured as
      // its 'done' outcome below; rendering it again here would duplicate it.
      break
    case 'done':
      closeRoleCard(frameId, summarize(event.content, 140))
      break
    case 'error':
      addRoleCardItem(frameId, 'error-item', '⚠ Error', event.message, false)
      closeRoleCard(frameId, '⚠ error')
      break
    // iteration / token_usage / ollama_request: live-only telemetry with
    // nothing worth a per-frame UI element.
  }
}

// The harness-level 'objective' event — always untagged, describing the whole task
// rather than one frame's turn. Rendered as a message-level card (splits the trace
// above/below), the same pattern the old task-graph/boss_verdict/replan narrative
// events used before the dispatch loop settled on its current, simpler shape
// (Boss/Planner/Implementer only — no task graph, no injected corrections).

function renderObjective(event) {
  const el = document.createElement('div')
  el.className = 'message objective'
  el.innerHTML = `<div class="objective-title">🎯 Objective</div><div class="objective-text">${escHtml(event.text)}</div>`
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
    copyBtn.textContent = '⧉ Copy'
    copyBtn.addEventListener('click', async () => {
      clearTimeout(copyBtn._resetTimer)
      try {
        await navigator.clipboard.writeText(content)
        copyBtn.textContent = '✓ Copied'
        copyBtn.classList.add('copied')
      } catch {
        copyBtn.textContent = '✕ Failed'
      }
      copyBtn._resetTimer = setTimeout(() => {
        copyBtn.textContent = '⧉ Copy'
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
  currentTraceBlock = null
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
  diffCompactBtn.classList.add('hidden')
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

// "Compact now" in the context viewer's title bar — replaces the old
// dropdown item. Only meaningfully enabled when idle (see viewContext()); the
// busy/manualCompacting guard here is a defensive backstop.
const diffCompactBtn = $('diff-compact-now')
diffCompactBtn.addEventListener('click', async () => {
  // updateCompactBtnState() only ever leaves this enabled while the baseline (not a
  // frame) is selected and not bypassed — but disabled buttons can still receive a
  // click from some assistive tech, so keep the same defensive re-check as before.
  if (diffCompactBtn.disabled || busy || manualCompacting) return
  diffCompactBtn.disabled = true
  diffCompactBtn.textContent = 'Compacting…'
  await compactNow()
  // Reload just the currently selected frame (the baseline, since that's the only
  // state this button is ever enabled in) rather than the full viewContext() — that
  // would re-fetch /frames and re-run the active/largest-frame default, silently
  // switching the view away from what the click was actually about. Guarded by
  // whether the context viewer (not the git-diff use of this modal, which hides
  // ctxFrameBar) is still the open view.
  if (diffModal.classList.contains('open') && !ctxFrameBar.classList.contains('hidden')) {
    await loadFrameContext(ctxSelectedFrame)
  } else {
    // Modal closed (or showing a git diff) mid-compaction — nothing to reload, but
    // still leave the button in a clean state for whenever it's shown again.
    diffCompactBtn.disabled = busy || manualCompacting
    diffCompactBtn.textContent = '⚡ Compact now'
  }
})

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

  // Draw an empty donut immediately (visible before the first token_usage), and
  // capture the auto-compaction threshold for the donut's tick.
  compactThreshold = typeof status.compactThreshold === 'number' ? status.compactThreshold : 0.667
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
