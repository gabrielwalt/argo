const $ = id => document.getElementById(id)

// API base — empty in standalone dev mode, '/ws/{name}' when served by central server
const API_BASE = window.__WS__ ? `/ws/${window.__WS__}` : ''

const messagesEl = $('messages')
const traceEl = $('trace')
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

// ── Session state ────────────────────────────────────────────────
let sessionStartTime = new Date()
let viewingSession = null  // null = current; object = past session being viewed
let currentSessionQuery = ''  // first user message of the current session

// ── Model options ────────────────────────────────────────────────
const DEFAULTS = { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 8192 }
const modelOpts = { ...DEFAULTS }

function syncSettingsUI() {
  $('opt-temperature').value = modelOpts.temperature
  $('opt-temperature-val').textContent = modelOpts.temperature.toFixed(2)
  $('opt-top-p').value = modelOpts.top_p
  $('opt-top-p-val').textContent = modelOpts.top_p.toFixed(2)
  $('opt-top-k').value = modelOpts.top_k
  $('opt-num-ctx').value = modelOpts.num_ctx
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
$('settings-reset').addEventListener('click', () => { Object.assign(modelOpts, DEFAULTS); syncSettingsUI() })

settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('open'))
syncSettingsUI()

function activateTraceTab() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
  document.querySelector('[data-tab="trace"]').classList.add('active')
  $('tab-trace').classList.add('active')
}

let busy = false

// ── SSE connection ───────────────────────────────────────────────
const es = new EventSource(`${API_BASE}/events`)

es.onopen = () => setStatus('ready', 'Ready')
es.onerror = () => setStatus('error', 'Disconnected — reload page')

es.onmessage = (e) => {
  const event = JSON.parse(e.data)
  handleEvent(event)
}

function handleEvent(event) {
  switch (event.type) {
    case 'start':
      clearTrace()
      activateTraceTab()
      setStatus('busy', `Running · ${event.model}`)
      tokenCounter.textContent = ''
      tokenCounter.className = ''
      break

    case 'iteration':
      iterLabel.textContent = `iter ${event.current}/${event.max}`
      addTraceItem('iteration', null, `── Iteration ${event.current} of ${event.max} ──`, false)
      break

    case 'thought':
      addTraceItem('thought', '💭 Thought', event.content, true)
      break

    case 'tool_call':
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
      // Only update chat panel if we're viewing the current session
      if (event.role === 'assistant' && !viewingSession) {
        addChatMessage('assistant', event.content)
      }
      break

    case 'token_usage': {
      const pct = Math.round(event.prompt_tokens / event.num_ctx * 100)
      tokenCounter.textContent = `${event.prompt_tokens.toLocaleString()} / ${event.num_ctx.toLocaleString()} ctx`
      tokenCounter.className = pct >= 90 ? 'ctx-danger' : pct >= 70 ? 'ctx-warn' : 'ctx-ok'
      break
    }

    case 'done':
      setStatus('ready', 'Ready')
      setBusy(false)
      iterLabel.textContent = ''
      refreshGitLog()
      refreshFilesIfVisible()
      break

    case 'git_commit':
      addTraceItem('git', `🔀 Committed`, `${event.hash} — ${event.message}`, false)
      refreshGitLog()
      break

    case 'error':
      addTraceItem('error-item', '⚠ Error', event.message, false)
      setStatus('error', 'Error')
      setBusy(false)
      break
  }
}

// ── UI helpers ───────────────────────────────────────────────────
function setStatus(state, text) {
  statusDot.className = state === 'ready' ? '' : state
  statusText.textContent = text
}

function setBusy(val) {
  busy = val
  sendBtn.disabled = val
  inputEl.disabled = val
  const sessionBtn = $('session-btn')
  if (sessionBtn) sessionBtn.disabled = val
}

function clearTrace() {
  traceEl.innerHTML = ''
}

function addTraceItem(className, label, body, collapsible) {
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

  traceEl.appendChild(el)
  traceEl.scrollTop = traceEl.scrollHeight
  return el
}

function renderMarkdown(content) {
  return marked.parse(content, { breaks: true, gfm: true })
}

function addChatMessage(role, content) {
  const el = document.createElement('div')
  el.className = `message ${role} md`
  el.innerHTML = renderMarkdown(content)
  el.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'))
  messagesEl.appendChild(el)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function addSystemMessage(text) {
  const el = document.createElement('div')
  el.className = 'message system'
  el.textContent = text
  messagesEl.appendChild(el)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

// ── Chat form ────────────────────────────────────────────────────
$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (busy || viewingSession) return

  const message = inputEl.value.trim()
  if (!message) return

  if (!currentSessionQuery) {
    currentSessionQuery = message
    updateSessionLabel()
  }
  addChatMessage('user', message)
  inputEl.value = ''
  setBusy(true)

  try {
    const resp = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, model: selectedModel, options: modelOpts }),
    })
    if (!resp.ok) {
      const err = await resp.json()
      addSystemMessage(`Error: ${err.error}`)
      setBusy(false)
    }
  } catch (err) {
    addSystemMessage(`Network error: ${err.message}`)
    setBusy(false)
  }
})

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('chat-form').dispatchEvent(new Event('submit'))
  }
})

// ── New session (called from session dropdown) ───────────────────
async function newSession() {
  if (viewingSession) returnToCurrentSession()
  await fetch(`${API_BASE}/reset`, { method: 'POST' })
  sessionStartTime = new Date()
  currentSessionQuery = ''
  updateSessionLabel()
  messagesEl.innerHTML = '<div class="message system">New session started.</div>'
  clearTrace()
  iterLabel.textContent = ''
  setStatus('ready', 'Ready')
}

// ── Model selector ───────────────────────────────────────────────
function selectModel(name) {
  selectedModel = name
  $('model-label').textContent = name
  // update active state in dropdown
  $('model-dropdown').querySelectorAll('.nav-drop-item').forEach(el => {
    el.classList.toggle('active', el.dataset.model === name)
  })
}

async function loadModels() {
  const dropdown = $('model-dropdown')
  const navModel = $('nav-model')

  // Toggle open/close
  $('model-btn').addEventListener('click', e => {
    e.stopPropagation()
    navModel.classList.toggle('open')
  })
  document.addEventListener('click', () => navModel.classList.remove('open'))

  try {
    const resp = await fetch(`${API_BASE}/models`)
    const models = await resp.json()
    dropdown.innerHTML = ''
    models.forEach(name => {
      const item = document.createElement('div')
      item.className = 'nav-drop-item'
      item.dataset.model = name
      item.textContent = name
      item.addEventListener('click', () => {
        selectModel(name)
        navModel.classList.remove('open')
      })
      dropdown.appendChild(item)
    })
    if (models.length) selectModel(models[0])
  } catch {
    const fallback = 'llama3.1:8b'
    const item = document.createElement('div')
    item.className = 'nav-drop-item active'
    item.dataset.model = fallback
    item.textContent = fallback
    item.addEventListener('click', () => {
      selectModel(fallback)
      navModel.classList.remove('open')
    })
    dropdown.appendChild(item)
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
      latestEl.innerHTML = '<span style="color:var(--muted)">No commits yet</span>'
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
    latestEl.innerHTML = '<span style="color:var(--muted)">Could not load git log.</span>'
  }
}

async function showDiff(hash) {
  diffContent.textContent = 'Loading…'
  diffTitle.textContent = hash.slice(0, 7)
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

// ── Files tab ────────────────────────────────────────────────────
async function refreshFiles() {
  const [wsTree, scratchTree] = await Promise.all([
    fetch(`${API_BASE}/files?dir=workspace`).then(r => r.json()).catch(() => []),
    fetch(`${API_BASE}/files?dir=scratch`).then(r => r.json()).catch(() => []),
  ])
  renderTree($('files-workspace-tree'), wsTree, 'workspace')
  renderTree($('files-scratch-tree'), scratchTree, 'scratch')
}

function refreshFilesIfVisible() {
  if ($('tab-files').classList.contains('active')) refreshFiles()
}

function renderTree(container, nodes, dir) {
  container.innerHTML = ''
  if (!nodes.length) {
    const el = document.createElement('div')
    el.className = 'file-empty'
    el.textContent = '(empty)'
    container.appendChild(el)
    return
  }
  for (const node of nodes) container.appendChild(makeFileNode(node, dir, ''))
}

function makeFileNode(node, dir, parentPath) {
  const filePath = parentPath ? `${parentPath}/${node.name}` : node.name
  const wrapper = document.createElement('div')

  if (node.type === 'dir') {
    wrapper.className = 'file-node dir'
    const row = document.createElement('div')
    row.className = 'file-row'
    row.innerHTML = `<span class="file-icon">▶</span><span class="file-name">${escHtml(node.name)}/</span>`

    const children = document.createElement('div')
    children.className = 'file-children'
    if (node.children?.length) {
      node.children.forEach(child => children.appendChild(makeFileNode(child, dir, filePath)))
    } else {
      const empty = document.createElement('div')
      empty.className = 'file-empty'
      empty.textContent = '(empty)'
      children.appendChild(empty)
    }

    row.addEventListener('click', () => {
      wrapper.classList.toggle('open')
      row.querySelector('.file-icon').textContent = wrapper.classList.contains('open') ? '▼' : '▶'
    })

    wrapper.appendChild(row)
    wrapper.appendChild(children)
  } else {
    wrapper.className = 'file-node file'
    const row = document.createElement('div')
    row.className = 'file-row'
    const size = node.size != null ? formatSize(node.size) : ''
    row.innerHTML = `<span class="file-icon">·</span><span class="file-name">${escHtml(node.name)}</span><span class="file-size">${size}</span>`
    row.addEventListener('click', () => openFilePreview(dir, filePath, node.name))
    wrapper.appendChild(row)
  }

  return wrapper
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

async function openFilePreview(dir, filePath, name) {
  diffTitle.textContent = name
  diffContent.textContent = 'Loading…'
  diffModal.classList.add('open')
  try {
    const resp = await fetch(`${API_BASE}/file?dir=${dir}&path=${encodeURIComponent(filePath)}`)
    diffContent.textContent = await resp.text()
  } catch {
    diffContent.textContent = 'Failed to load file.'
  }
}

$('refresh-files').addEventListener('click', refreshFiles)

// ── Tab switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
    btn.classList.add('active')
    $(`tab-${tab}`).classList.add('active')
    if (tab === 'logs') refreshLogs()
    if (tab === 'files') refreshFiles()
  })
})

// ── Session logs tab ─────────────────────────────────────────────
const logsList = $('logs-list')
const logViewer = $('log-viewer')
const logsCount = $('logs-count')
let currentLogFile = null
let currentFmt = 'md'

async function refreshLogs() {
  try {
    const resp = await fetch(`${API_BASE}/logs`)
    const logs = await resp.json()
    logsCount.textContent = `${logs.length} session${logs.length !== 1 ? 's' : ''}`

    if (logs.length === 0) {
      logsList.innerHTML = '<span style="color:var(--muted)">No logs yet. Run a query to generate one.</span>'
      return
    }

    logsList.innerHTML = ''
    logs.forEach(log => {
      const el = document.createElement('div')
      el.className = 'log-entry'
      el.innerHTML = `
        <span class="log-ts">${formatDate(log.startedAt)}</span>
        <span class="log-query" title="${escHtml(log.query)}">${escHtml(log.query)}</span>
        <span class="log-meta">${log.model} · ${log.toolCalls} tools · ${log.durationMs ? (log.durationMs/1000).toFixed(1)+'s' : '—'}</span>
        <span class="log-status ${log.status}">${log.status}</span>
      `
      el.addEventListener('click', () => openLog(log.filename, log.query))
      logsList.appendChild(el)
    })
  } catch {
    logsList.innerHTML = '<span style="color:var(--muted)">Could not load logs.</span>'
  }
}

async function openLog(filename, query) {
  currentLogFile = filename
  logsList.parentElement.style.display = 'none'
  logViewer.style.display = 'flex'
  $('log-viewer-title').textContent = filename
  $('log-viewer-content').textContent = 'Loading…'
  await loadLogContent(filename, currentFmt)
}

async function loadLogContent(filename, fmt) {
  try {
    const resp = await fetch(`${API_BASE}/logs/${filename}?format=${fmt}`)
    $('log-viewer-content').textContent = await resp.text()
  } catch {
    $('log-viewer-content').textContent = 'Failed to load.'
  }
}

$('back-to-logs').addEventListener('click', () => {
  logViewer.style.display = 'none'
  logsList.parentElement.style.display = 'flex'
  currentLogFile = null
})

document.querySelectorAll('.log-fmt-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    currentFmt = btn.dataset.fmt
    document.querySelectorAll('.log-fmt-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    if (currentLogFile) await loadLogContent(currentLogFile, currentFmt)
  })
})

$('refresh-logs').addEventListener('click', refreshLogs)

es.addEventListener('message', (e) => {
  const event = JSON.parse(e.data)
  if (event.type === 'done' && $('tab-logs').classList.contains('active')) {
    setTimeout(refreshLogs, 500)
  }
})

// ── Session switcher (breadcrumb: session crumb) ─────────────────

function truncateQuery(q, max = 24) {
  return q.length > max ? q.slice(0, max).trimEnd() + '…' : q
}

function updateSessionLabel() {
  const label = $('session-label')
  if (!label) return
  if (viewingSession) {
    label.textContent = viewingSession.query ? truncateQuery(viewingSession.query) : 'Session'
  } else {
    label.textContent = currentSessionQuery ? truncateQuery(currentSessionQuery) : 'Session'
  }
}

async function refreshSessionDropdown() {
  const dropdown = $('session-dropdown')
  dropdown.innerHTML = ''

  // "New session" action
  const newItem = document.createElement('div')
  newItem.className = 'nav-drop-item'
  newItem.style.cssText = 'color:var(--text);gap:10px'
  newItem.innerHTML = `<span style="color:var(--gold);font-size:11px">✦</span> New session`
  newItem.addEventListener('click', () => {
    $('nav-session').classList.remove('open')
    newSession()
  })
  dropdown.appendChild(newItem)

  const sep0 = document.createElement('div')
  sep0.className = 'nav-drop-sep'
  dropdown.appendChild(sep0)

  const header = document.createElement('div')
  header.className = 'nav-drop-label'
  header.textContent = 'Sessions'
  dropdown.appendChild(header)

  // Current session entry
  const currItem = document.createElement('div')
  currItem.className = `nav-drop-item ${!viewingSession ? 'active' : ''}`
  const msgCount = messagesEl.querySelectorAll('.message.user, .message.assistant').length
  const currTime = sessionStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  currItem.innerHTML = `<span style="flex-shrink:0;color:var(--green);font-size:9px">●</span><span>Now · ${currTime}</span><span style="margin-left:auto;opacity:.5;font-size:11px">${msgCount} msg${msgCount !== 1 ? 's' : ''}</span>`
  currItem.addEventListener('click', () => {
    $('nav-session').classList.remove('open')
    if (viewingSession) returnToCurrentSession()
  })
  dropdown.appendChild(currItem)

  // Past sessions from logs
  try {
    const sessions = await fetch(`${API_BASE}/logs`).then(r => r.json())
    if (sessions.length > 0) {
      const sep = document.createElement('div')
      sep.className = 'nav-drop-sep'
      dropdown.appendChild(sep)

      sessions.slice(0, 30).forEach(s => {
        const item = document.createElement('div')
        item.className = `nav-drop-item ${viewingSession?.filename === s.filename ? 'active' : ''}`
        const d = new Date(s.startedAt)
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const dateStr = isToday(d) ? timeStr : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr
        const query = s.query.length > 32 ? s.query.slice(0, 32) + '…' : s.query
        item.innerHTML = `<span style="flex-shrink:0;color:var(--muted);font-size:11px;min-width:72px">${dateStr}</span><span style="overflow:hidden;text-overflow:ellipsis">${escHtml(query)}</span>`
        item.title = s.query
        item.addEventListener('click', () => {
          $('nav-session').classList.remove('open')
          viewSessionEntry(s)
        })
        dropdown.appendChild(item)
      })
    }
  } catch { /* logs endpoint unavailable in some modes */ }
}

function isToday(date) {
  const now = new Date()
  return date.toDateString() === now.toDateString()
}

async function viewSessionEntry(session) {
  viewingSession = session
  updateSessionLabel()

  try {
    const resp = await fetch(`${API_BASE}/logs/${session.filename}?format=jsonl`)
    const text = await resp.text()
    const events = text.trim().split('\n')
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    const messages = events.filter(e => e.type === 'message')

    messagesEl.innerHTML = ''
    const d = new Date(session.startedAt)
    const dateStr = (isToday(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ') +
                    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    addSystemMessage(`${dateStr} · ${session.model}`)
    messages.forEach(m => addChatMessage(m.role, m.content))

    // Show banner, hide input form
    $('session-banner-label').textContent = `Viewing session from ${dateStr}`
    $('session-banner').classList.add('visible')
    $('chat-form').style.display = 'none'
  } catch {
    addSystemMessage('Could not load session.')
  }
}

async function returnToCurrentSession() {
  viewingSession = null
  updateSessionLabel()
  $('session-banner').classList.remove('visible')
  $('chat-form').style.display = ''

  // Restore current conversation from server
  messagesEl.innerHTML = ''
  try {
    const resp = await fetch(`${API_BASE}/history`)
    const messages = await resp.json()
    if (messages.length === 0) {
      messagesEl.innerHTML = '<div class="message system">Session started. Ask anything.</div>'
    } else {
      const userCount = messages.filter(m => m.role === 'user').length
      addSystemMessage(`― ${userCount} message${userCount !== 1 ? 's' : ''} in current session ―`)
      messages.forEach(m => addChatMessage(m.role, m.content))
    }
  } catch {
    messagesEl.innerHTML = '<div class="message system">Session started. Ask anything.</div>'
  }
}

$('return-btn').addEventListener('click', returnToCurrentSession)

// ── Nav init ─────────────────────────────────────────────────────
async function initNav() {
  // Session crumb — always visible
  updateSessionLabel()

  const navSession = $('nav-session')
  const sessionBtn = $('session-btn')

  sessionBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (busy) return
    const isOpen = navSession.classList.toggle('open')
    if (isOpen) refreshSessionDropdown()
  })

  // Close session dropdown on outside click (always)
  document.addEventListener('click', () => navSession.classList.remove('open'))

  // Workspace crumb — only in central/worker mode
  if (!window.__WS__) return

  $('sep-ws').style.display = 'inline'
  $('nav-ws').style.display = 'inline-flex'
  $('ws-name-label').textContent = window.__WS__

  const navWs = $('nav-ws')
  const wsBtn = $('ws-btn')

  wsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    navWs.classList.toggle('open')
  })

  // Build workspace dropdown — always render scaffold; populate others from API
  const wsDropdown = $('ws-dropdown')
  wsDropdown.innerHTML = ''

  const wsLabel = document.createElement('div')
  wsLabel.className = 'nav-drop-label'
  wsLabel.textContent = 'Workspaces'
  wsDropdown.appendChild(wsLabel)

  const currWs = document.createElement('div')
  currWs.className = 'nav-drop-item active'
  currWs.innerHTML = `<span style="flex-shrink:0;color:var(--green);font-size:9px">●</span>${escHtml(window.__WS__)}`
  wsDropdown.appendChild(currWs)

  // Placeholder for other running workspaces (filled by API)
  const othersContainer = document.createElement('div')
  wsDropdown.appendChild(othersContainer)

  const sepAll = document.createElement('div')
  sepAll.className = 'nav-drop-sep'
  wsDropdown.appendChild(sepAll)

  const allLink = document.createElement('a')
  allLink.className = 'nav-drop-item'
  allLink.href = '/'
  allLink.innerHTML = `<span style="opacity:.5">←</span> All workspaces`
  wsDropdown.appendChild(allLink)

  const sepAttach = document.createElement('div')
  sepAttach.className = 'nav-drop-sep'
  wsDropdown.appendChild(sepAttach)

  const attachLabel = document.createElement('div')
  attachLabel.className = 'nav-drop-label'
  attachLabel.textContent = 'Attach folder'
  wsDropdown.appendChild(attachLabel)

  const attachRow = document.createElement('div')
  attachRow.className = 'nav-drop-attach'
  attachRow.innerHTML = `<input type="text" placeholder="/path/to/project" spellcheck="false" autocomplete="off"><button type="button">Attach</button>`
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
      window.open(data.url, '_blank')
      navWs.classList.remove('open')
      attachInput.value = ''
    } catch (err) {
      attachInput.value = ''
      attachInput.placeholder = err.message
      setTimeout(() => { attachInput.placeholder = '/path/to/project' }, 3000)
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

  // Populate other running workspaces from API (best-effort)
  try {
    const workspaces = await fetch('/api/workspaces').then(r => r.json())
    const others = workspaces.filter(w => w.name !== window.__WS__ && w.running)
    if (others.length > 0) {
      const sep = document.createElement('div')
      sep.className = 'nav-drop-sep'
      othersContainer.appendChild(sep)
      others.forEach(w => {
        const a = document.createElement('a')
        a.className = 'nav-drop-item'
        a.href = `/ws/${w.name}/`
        a.textContent = w.name
        othersContainer.appendChild(a)
      })
    }
  } catch { /* standalone dev — no workspace API */ }

  // Close workspace dropdown on outside click
  document.addEventListener('click', () => navWs.classList.remove('open'))
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

async function loadHistory() {
  try {
    const resp = await fetch(`${API_BASE}/history`)
    const messages = await resp.json()
    if (!messages.length) return
    const firstUser = messages.find(m => m.role === 'user')
    if (firstUser && !currentSessionQuery) {
      currentSessionQuery = firstUser.content
      updateSessionLabel()
    }
    const userCount = messages.filter(m => m.role === 'user').length
    addSystemMessage(`― Session restored · ${userCount} message${userCount !== 1 ? 's' : ''} ―`)
    messages.forEach(m => addChatMessage(m.role, m.content))
  } catch { }
}

loadModels()
refreshGitLog()
loadHistory()
initNav()
