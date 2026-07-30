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
const tokenCounter = $('token-counter')
const settingsBtn = $('settings-btn')
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
let ctxState = { promptTokens: 0, numCtx: 0, pct: 0 }
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
// Current iteration number, shown in the donut's center while busy/running.
let currentIteration = null
// True from 'compact_start' until 'compact' (or a safety-net clear on the next
// 'iteration'/'error') — independent of `busy` since manual compaction can run
// between agent runs.
let compactingNow = false
let compactStartTime = null
// Live progress from 'compact_progress' (precise, while available); falls back
// to the previous compaction's duration as a rough estimate.
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

  // Core: solid state color, filling the middle of the ring. Flashes while compacting.
  const coreColor = { ready: 'var(--green)', busy: 'var(--yellow)', compacting: 'var(--purple)', error: 'var(--red)' }[indicatorState] || 'var(--green)'
  const coreClass = indicatorState === 'compacting' ? 'ctx-core compacting' : 'ctx-core'
  const coreR = r - sw / 2 - 2.5
  // Iteration number, shown only while actually running (not idle/compacting).
  const centerText = (indicatorState === 'busy' && currentIteration) ? String(currentIteration) : ''

  tokenCounter.innerHTML =
    `<svg class="ctx-donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"`
    + ` stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
    + `<line class="ctx-tick" x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="var(--text)" stroke-width="1.5"/>`
    + `<circle class="${coreClass}" cx="${cx}" cy="${cy}" r="${coreR.toFixed(2)}" fill="${coreColor}"/>`
    + (centerText ? `<text x="${cx}" y="${cy}" class="ctx-center-text" text-anchor="middle" dominant-baseline="central">${escHtml(centerText)}</text>` : '')
    + `</svg>`
}

// Update stored context size + redraw. Precise numbers show in the dropdown;
// the donut itself only ever shows the ring (usage), tick (threshold) and
// core+center-text (agent state / iteration).
function updateCtx(promptTokens, numCtx) {
  const pct = numCtx ? Math.round(promptTokens / numCtx * 100) : 0
  ctxState = { promptTokens, numCtx, pct }
  renderDonut()
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
const DEFAULTS = { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 65536 }
const modelOpts = { ...DEFAULTS }
const MAX_ITERATIONS_DEFAULT = 1000
let maxIterations = MAX_ITERATIONS_DEFAULT
// Grounding & self-consistency guard (writing/research tasks). Default ON; sent with
// every /chat request so the worker's per-run flag matches this toggle.
let grounding = true

function syncSettingsUI() {
  $('opt-temperature').value = modelOpts.temperature
  $('opt-temperature-val').textContent = modelOpts.temperature.toFixed(2)
  $('opt-top-p').value = modelOpts.top_p
  $('opt-top-p-val').textContent = modelOpts.top_p.toFixed(2)
  $('opt-top-k').value = modelOpts.top_k
  $('opt-num-ctx').value = modelOpts.num_ctx
  $('opt-max-iterations').value = maxIterations
  $('opt-max-iterations-val').textContent = maxIterations
  $('opt-grounding').checked = grounding
}

$('opt-temperature').addEventListener('input', e => {
  modelOpts.temperature = parseFloat(e.target.value)
  $('opt-temperature-val').textContent = modelOpts.temperature.toFixed(2)
})
$('opt-top-p').addEventListener('input', e => {
  modelOpts.top_p = parseFloat(e.target.value)
  $('opt-top-p-val').textContent = modelOpts.top_p.toFixed(2)
})
$('opt-top-k').addEventListener('change', e => { modelOpts.top_k = parseInt(e.target.value, 10) })
$('opt-num-ctx').addEventListener('change', e => { modelOpts.num_ctx = parseInt(e.target.value, 10) })
$('opt-max-iterations').addEventListener('input', e => {
  maxIterations = parseInt(e.target.value, 10)
  $('opt-max-iterations-val').textContent = maxIterations
})
$('opt-grounding').addEventListener('change', e => { grounding = e.target.checked })
$('settings-reset').addEventListener('click', () => {
  Object.assign(modelOpts, DEFAULTS)
  maxIterations = MAX_ITERATIONS_DEFAULT
  grounding = true
  syncSettingsUI()
})

settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('open'))
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

es.onopen = () => { if (!busy) setStatus('ready', 'Ready') }  // don't clobber a running state on (re)connect
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
  switch (event.type) {
    case 'start':
      currentRunModel = event.model
      currentIteration = null
      startTraceBlock(event.model)
      setStatus('busy', `Running · ${event.model}`)
      break

    case 'iteration':
      currentIteration = event.current
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

    case 'plan':
      renderPlan(event)
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
      currentIteration = null
      refreshGitLog()
      refreshFiles()
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
      }
      break
    }

    case 'compact_start':
      // Compaction involves separate LLM calls (update + validate) that can take
      // up to a couple minutes total — without this the run just looks stalled.
      // compactingNow (checked by setStatus) makes the indicator's core flash
      // violet and its dropdown status row show compaction progress, regardless
      // of whether this happens mid-run or as a standalone manual compaction.
      compactingNow = true
      compactStartTime = Date.now()
      compactElapsedS = null
      compactTimeoutS = null
      compactStep = null
      setStatus('busy', 'Compacting context…')
      addTraceItem('compact', '📦 Compacting context', `${event.messageCount} messages, ${Math.round(event.contextUsagePct * 100)}% context — updating working memory…`, false)
      surfaceActivity('📦 Compacting context…')
      break

    case 'compact_progress': {
      // Periodic proof-of-life from a still-running compaction sub-call (see
      // withCompactHeartbeat in agent.ts) — this is what tells you it's actually
      // working and not just hung, since compact_start only fires once at the start.
      const elapsedS = Math.round(event.elapsedMs / 1000)
      const timeoutS = Math.round(event.timeoutMs / 1000)
      compactElapsedS = elapsedS
      compactTimeoutS = timeoutS
      compactStep = event.step
      setStatus('busy', `Compacting context… ${event.step} (${elapsedS}s / ${timeoutS}s)`)
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
      addTraceItem('compact', `⚡ Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}${event.activeWorkingStateSummary ? `\n\n--- Active working state (unvalidated) ---\n${event.activeWorkingStateSummary}` : ''}`, true)
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
      break

    case 'error':
      addTraceItem('error-item', '⚠ Error', event.message, false)
      compactingNow = false
      setStatus('error', 'Error')
      finalizeTraceBlock()
      setBusy(false)
      break
  }
}

// Renders one PERSISTED (replayed) event into the trace/chat. Reuses the same
// DOM helpers as the live path for identical visual output, but omits every
// live-only side effect (status bar, busy state, git/file refreshes, iteration
// and token counters — those reflect a *running* agent, not history). Unlike the
// live path it also renders user messages: on replay there is no submit handler
// to have added them optimistically. ollama_request / compact_progress /
// token_usage are live-only telemetry with nothing to draw into the trace.
function handleEventForSession(event) {
  switch (event.type) {
    case 'start':
      startTraceBlock(event.model)
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

    case 'plan':
      renderPlan(event)
      break

    case 'compact_start':
      addTraceItem('compact', '📦 Compacting context', `${event.messageCount} messages, ${Math.round(event.contextUsagePct * 100)}% context — updating working memory…`, false)
      break

    case 'compact':
      addTraceItem('compact', `⚡ Context compacted (${event.messagesBefore}→${event.messagesAfter} msgs)`, `${event.rangeDescription}\n\n${event.summary}${event.activeWorkingStateSummary ? `\n\n--- Active working state (unvalidated) ---\n${event.activeWorkingStateSummary}` : ''}`, true)
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
// set/cleared around the compact_start/compact events) overrides to
// 'compacting' regardless of what's passed here, since a compaction can occur
// either mid-run or standalone between runs.
function setStatus(state, text) {
  statusDot.className = state === 'ready' ? '' : state
  statusText.textContent = text
  indicatorState = compactingNow ? 'compacting' : state
  renderDonut()
  // Keep an open dropdown's status/context rows live rather than stale text.
  if (navCtx.classList.contains('open')) buildCtxDropdown()
}

// The outer layer always does the sail-past traverse; the inner layer rocks with one random
// motion (roll is weighted so the stronger lean shows up most often). Cleared when off.
const SAIL_ROCKS = ['roll', 'roll', 'pitch', 'yaw', 'bob']
function setSailing(on) {
  const m1 = sendBoat.querySelector('.m1')
  const m2 = sendBoat.querySelector('.m2')
  if (!m1 || !m2) return
  m1.classList.remove('a-sail')
  for (const r of ['roll', 'pitch', 'yaw', 'bob']) m2.classList.remove('a-' + r)
  if (!on) return
  m1.classList.add('a-sail')
  m2.classList.add('a-' + SAIL_ROCKS[Math.floor(Math.random() * SAIL_ROCKS.length)])
}

function setBusy(val) {
  busy = val
  // Leave the textarea enabled while the agent runs so the user can queue prompts.
  inputEl.placeholder = val ? 'Queue a prompt… (Enter to queue)' : originalPlaceholder

  if (val) {
    // The boat stays visible and sails while the agent runs: setSailing picks 1-2 random
    // motions (pitch/roll/yaw/bob/sway) across the two nested layers so their transforms
    // cumulate. Hovering the button swaps the boat for the stop square (hover handlers).
    sendBoat.classList.remove('hidden')
    sendStop.classList.add('hidden')
    setSailing(true)
    sendBtn.title = 'Stop'
  } else {
    setSailing(false)
    sendBoat.classList.remove('hidden')
    sendStop.classList.add('hidden')
    sendBtn.title = 'Send'
    stopRequested = false
  }
}

let stopRequested = false

async function stopAgent() {
  // Abort only takes effect once the current model/tool call finishes, which can
  // take a while — without this the click looks like it did nothing in the meantime.
  stopRequested = true
  setStatus('busy', 'Stopping…')
  try { await fetch(`${API_BASE}/stop`, { method: 'POST' }) } catch { /* ignore */ }
}

// ── Combined indicator dropdown ───────────────────────────────────
// Clicking the indicator opens a dropdown with three rows: status+model
// (opens the settings panel), precise context numbers (opens the context
// viewer), and "Clear conversation" (replaces the old standalone new-session
// button). Reuses the .nav-crumb / .nav-dropdown pattern, so
// closeAllDropdowns() (outside-click + Escape) closes it for free. "Compact
// now" lives in the context viewer's title bar instead of here (see
// viewContext()).
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

  // Row 1 — textual status + model. Click opens the LLM settings panel.
  const statusRow = document.createElement('div')
  statusRow.className = 'nav-drop-item ctx-drop-status'
  statusRow.innerHTML = `<span>${escHtml(compactStatusText())}</span>`
  statusRow.addEventListener('click', () => {
    navCtx.classList.remove('open')
    settingsPanel.classList.add('open')
  })
  ctxDropdown.appendChild(statusRow)

  // Row 2 — precise context numbers. Click opens the context viewer.
  const ctxRow = document.createElement('div')
  ctxRow.className = 'nav-drop-item'
  const ctxTxt = ctxState.numCtx
    ? `${ctxState.promptTokens.toLocaleString()} / ${ctxState.numCtx.toLocaleString()} tokens · ${ctxState.pct}%`
    : 'No context usage yet'
  ctxRow.innerHTML = `<span>🔍 ${escHtml(ctxTxt)}</span>`
  ctxRow.addEventListener('click', () => {
    navCtx.classList.remove('open')
    viewContext()
  })
  ctxDropdown.appendChild(ctxRow)

  const sep = document.createElement('div')
  sep.className = 'nav-drop-sep'
  ctxDropdown.appendChild(sep)

  // Row 3 — clear conversation (was the standalone "＋" button in the breadcrumb).
  const clearDisabled = busy
  const clearRow = document.createElement('div')
  clearRow.className = `nav-drop-item${clearDisabled ? ' disabled' : ''}`
  clearRow.innerHTML = `<span>＋ Clear conversation</span>${clearDisabled ? '<span class="ctx-hint">running…</span>' : ''}`
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
// Ensures a trace block exists so the compact_start/compact events have somewhere
// to render; those events (see handleEvent) finalize the block on completion.
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
    // Success: the compact_start / compact events render into the trace and
    // finalize the block (see handleEvent). Nothing more to do here.
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

// View the exact context the model currently sees. Read-only; reuses #diff-modal.
// The modal's title bar carries a "Compact now" action (replacing the old
// dropdown item), enabled only when the agent is idle and not already
// compacting.
async function viewContext() {
  diffTitle.textContent = 'Context'
  diffContent.textContent = 'Loading…'
  diffCompactBtn.classList.remove('hidden')
  diffCompactBtn.disabled = busy || manualCompacting
  diffCompactBtn.textContent = '⚡ Compact now'
  diffModal.classList.add('open')
  try {
    const resp = await fetch(`${API_BASE}/context`)
    if (!resp.ok) throw new Error('bad status')
    const data = await resp.json()
    diffTitle.textContent = `Context (${data.messageCount ?? 0} messages · ${(data.totalChars ?? 0).toLocaleString()} chars · num_ctx ${(data.numCtx ?? 0).toLocaleString()})`
    diffContent.innerHTML = renderContext(data)
  } catch {
    diffModal.classList.remove('open')
    showToast('Failed to load context')
  }
}

function renderContext(data) {
  let html = ''
  if (data.compaction != null) {
    const c = data.compaction
    const text = typeof c === 'string' ? c : JSON.stringify(c, null, 2)
    html += `<div class="ctx-msg ctx-ledger"><div class="ctx-role">Compaction ledger</div><div class="ctx-content">${escHtml(text)}</div></div>`
  }
  for (const m of (data.messages ?? [])) {
    const role = String(m.role ?? '')
    html += `<div class="ctx-msg"><div class="ctx-role ctx-role-${escHtml(role)}">${escHtml(role)} · ${(m.chars ?? 0).toLocaleString()} chars</div><div class="ctx-content">${escHtml(m.content ?? '')}</div></div>`
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

function addTraceItem(className, label, body, collapsible) {
  if (!currentTraceBlock) return null
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

  currentTraceBlock.items.appendChild(el)
  maybeAutoScroll()
  return el
}

function renderMarkdown(content) {
  return marked.parse(content, { breaks: true, gfm: true })
}

// Renders the agent's plan as a message-level card in the chat flow (not buried
// in the collapsed trace) so the user sees it like any other message. Each
// update_plan call emits a fresh 'plan' event, so refinements pop up as their own
// cards, labelled with the revision.
function renderPlan(event) {
  // A plan is a milestone in the run. Close off the trace that led up to it,
  // render the plan as its own card, then RESUME the trace in a fresh block so
  // post-plan execution unrolls *below* the plan (chronological order) instead
  // of continuing to fill the pre-plan block *above* it — the latter read as
  // "the agent planned but never proceeded." An empty pre-plan block (the model
  // planned immediately) is dropped rather than left as a stray "0 tools" block.
  const model = currentRunModel
  const resume = !!currentTraceBlock
  if (currentTraceBlock && currentTraceBlock.items.childElementCount === 0) {
    currentTraceBlock.el.remove()
    currentTraceBlock = null
  } else {
    finalizeTraceBlock()
  }

  const el = document.createElement('div')
  el.className = 'message plan md'
  const title = event.revision > 1 ? `📋 Plan · revised (v${event.revision})` : '📋 Plan'
  const steps = (event.steps || []).map(s => `<li>${escHtml(s)}</li>`).join('')
  el.innerHTML = `<div class="plan-title">${escHtml(title)}</div>`
    + `<div class="plan-objective"><span class="plan-label">Objective</span> ${escHtml(event.objective)}</div>`
    + (steps ? `<ol class="plan-steps">${steps}</ol>` : '')
  messagesEl.appendChild(el)

  // Resume the live trace below the plan card so execution renders in order.
  if (resume) startTraceBlock(model)
  maybeAutoScroll()
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
      body: JSON.stringify({ message, model: selectedModel, options: modelOpts, maxIterations, grounding }),
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
  currentIteration = null
  compactingNow = false
  setStatus('ready', 'Ready')
  // Track the new live session id so its events are the ones replayed later.
  const st = await fetch(`${API_BASE}/status`).then(r => r.json()).catch(() => ({}))
  currentLiveSessionId = st?.sessionId ?? ''
}

// ── Dropdown mutual exclusion ─────────────────────────────────────
function closeAllDropdowns() {
  document.querySelectorAll('.nav-crumb.open').forEach(el => el.classList.remove('open'))
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

  select.addEventListener('change', e => selectModel(e.target.value))

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
    if (models.length) selectModel(models[0])
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
  diffModal.classList.add('open')

  try {
    const resp = await fetch(`${API_BASE}/git-diff/${hash}`)
    const text = await resp.text()
    diffContent.innerHTML = colorize(text)
  } catch {
    diffContent.textContent = 'Failed to load diff.'
  }
}

function colorize(text) {
  return text.split('\n').map(line => {
    const esc = escHtml(line)
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="add">${esc}</span>`
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="del">${esc}</span>`
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) return `<span class="meta">${esc}</span>`
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
  if (busy || manualCompacting) return
  diffCompactBtn.disabled = true
  diffCompactBtn.textContent = 'Compacting…'
  await compactNow()
  diffCompactBtn.disabled = busy || manualCompacting
  diffCompactBtn.textContent = '⚡ Compact now'
  // Refresh the numbers shown if the context viewer is still the open modal.
  if (diffModal.classList.contains('open') && diffTitle.textContent.startsWith('Context')) {
    viewContext()
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

// Debounced live refresh of the workspace panels while the agent works: rebuilds the file
// tree (preserving state) and re-renders the currently-viewed file, so newly created files
// appear and a touched-and-viewed file updates in place. Debounced so a burst of edits
// triggers one refresh.
let wsRefreshTimer = null
function scheduleWorkspaceRefresh() {
  clearTimeout(wsRefreshTimer)
  wsRefreshTimer = setTimeout(() => {
    refreshFiles()
    if (currentViewerPath) {
      const kind = window.ArgoPreview ? ArgoPreview.previewKindFor(currentViewerPath) : null
      renderViewer(currentViewerPath, kind)
    }
  }, 700)
}

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

  currentViewerPath = filePath
  const pathEl = $('file-viewer-path')
  const toggleEl = $('file-viewer-toggle')
  pathEl.textContent = `/${filePath}`

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
  contentEl.classList.remove('file-viewer-empty')
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

$('file-viewer-close').addEventListener('click', () => {
  if (activeFileRow) { activeFileRow.classList.remove('active'); activeFileRow = null }
  currentViewerPath = null
  $('file-viewer-toggle').classList.add('hidden')
  $('file-viewer-path').textContent = ''
  const contentEl = $('file-viewer-content')
  contentEl.classList.remove('preview-mode')
  contentEl.textContent = 'Select a file to view'
  contentEl.classList.add('file-viewer-empty')
})

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

$('refresh-files').addEventListener('click', refreshFiles)


// ── Nav init ─────────────────────────────────────────────────────
async function initNav() {
  // "Clear conversation" now lives in the combined indicator's dropdown (see
  // buildCtxDropdown) — the old standalone "＋" breadcrumb button is gone.

  // Workspace crumb — only in central/worker mode
  if (!window.__WS__) return

  $('sep-ws').style.display = 'inline'
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

  // Build workspace dropdown — attach form at top, then workspace list
  const wsDropdown = $('ws-dropdown')
  wsDropdown.innerHTML = ''

  // Attach form at top
  const attachRow = document.createElement('div')
  attachRow.className = 'nav-drop-attach'
  attachRow.innerHTML = `<input type="text" placeholder="Attach /path/to/folder…" spellcheck="false" autocomplete="off"><button type="button">Attach</button>`
  wsDropdown.appendChild(attachRow)

  const attachInput = attachRow.querySelector('input')
  const attachBtn = attachRow.querySelector('button')

  async function doAttach() {
    const p = attachInput.value.trim()
    if (!p) { attachInput.focus(); return }
    attachBtn.textContent = '…'
    attachBtn.disabled = true
    try {
      const resp = await fetch('/api/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? 'Failed')
      window.location.href = data.url
      attachInput.value = ''
    } catch (err) {
      attachInput.value = ''
      attachInput.placeholder = err.message
      setTimeout(() => { attachInput.placeholder = 'Attach /path/to/folder…' }, 3000)
    } finally {
      attachBtn.textContent = 'Attach'
      attachBtn.disabled = false
    }
  }

  attachBtn.addEventListener('click', doAttach)
  attachRow.addEventListener('click', e => e.stopPropagation())
  attachInput.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') doAttach()
  })

  const sepAttach = document.createElement('div')
  sepAttach.className = 'nav-drop-sep'
  wsDropdown.appendChild(sepAttach)

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
      const sep = document.createElement('div')
      sep.className = 'nav-drop-sep'
      othersContainer.appendChild(sep)
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
  document.querySelector('header').classList.add('hidden')
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

  // Draw an empty donut immediately (visible before the first token_usage), and
  // capture the auto-compaction threshold for the donut's tick.
  compactThreshold = typeof status.compactThreshold === 'number' ? status.compactThreshold : 0.667
  renderDonut()

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
