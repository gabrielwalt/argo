// Document preview system for Argo's file viewer. Exposes window.ArgoPreview.
// Renders HTML docs in a sandboxed iframe, markdown via marked, and images
// inline. All builders throw on failure so the caller can fall back to the
// raw source view. Vanilla JS, no deps beyond the globally-loaded marked/hljs.
(function () {
  'use strict'

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])

  function extOf(filePath) {
    const name = String(filePath).split('/').pop().toLowerCase()
    return name.includes('.') ? name.split('.').pop() : ''
  }

  function previewKindFor(filePath) {
    const ext = extOf(filePath)
    if (ext === 'html' || ext === 'htm') return 'html'
    if (ext === 'md' || ext === 'markdown') return 'markdown'
    if (IMAGE_EXTS.has(ext)) return 'image'
    return null
  }

  function hasToggle(kind) {
    return kind === 'html' || kind === 'markdown'
  }

  function getMode(kind) {
    try {
      const v = localStorage.getItem('argo:previewMode:' + kind)
      return v === 'source' ? 'source' : 'preview'
    } catch {
      return 'preview'
    }
  }

  function setMode(kind, mode) {
    try {
      localStorage.setItem('argo:previewMode:' + kind, mode === 'source' ? 'source' : 'preview')
    } catch {
      /* storage unavailable — ignore */
    }
  }

  // path minus its last segment ('a/b/c.md' -> 'a/b', 'x.md' -> '')
  function dirOf(path) {
    const p = String(path)
    const i = p.lastIndexOf('/')
    return i === -1 ? '' : p.slice(0, i)
  }

  // Join baseDir + rel and normalize '.' / '..' segments. Returns a
  // tree-relative path with no leading slash.
  function resolveRelative(baseDir, rel) {
    const r = String(rel)
    // Absolute-ish rel (leading slash) resets to root of the tree.
    const startSegs = r.charAt(0) === '/' ? [] : String(baseDir).split('/').filter(Boolean)
    const relSegs = r.replace(/^\/+/, '').split('/')
    const out = startSegs.slice()
    for (const seg of relSegs) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') { out.pop(); continue }
      out.push(seg)
    }
    return out.join('/')
  }

  // Normalize a link target (which may be an absolute URL, a /raw/ path, or a
  // relative path) to a tree-relative path, then hand it to onNavigate.
  function handleInternalLink(targetWorkspacePath, currentFilePath, onNavigate) {
    let t = String(targetWorkspacePath)
    // Strip query/hash — the tree open only cares about the path.
    t = t.replace(/[?#].*$/, '')
    // Strip an origin if a full URL slipped through.
    const originMatch = t.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i)
    if (originMatch) t = originMatch[1]
    // Strip a /raw/ (or /ws/<name>/raw/) prefix.
    const rawIdx = t.indexOf('/raw/')
    if (rawIdx !== -1) {
      t = t.slice(rawIdx + '/raw/'.length)
    } else if (/^\.?\.?\//.test(t) || !t.startsWith('/')) {
      // Relative link — resolve against the current file's directory.
      t = resolveRelative(dirOf(currentFilePath), t)
    } else {
      // Leading-slash path with no /raw/ — treat as tree-relative.
      t = t.replace(/^\/+/, '')
    }
    t = t.replace(/^\/+/, '')
    if (t && typeof onNavigate === 'function') onNavigate(t)
  }

  // True if a resolved URL points at the same origin as the page (a workspace
  // resource served under /raw/), false for external links.
  function isSameOrigin(url) {
    try {
      return url.origin === window.location.origin
    } catch {
      return false
    }
  }

  function renderHtmlPreview(opts, container) {
    const { filePath, apiBase, onNavigate } = opts
    const iframe = document.createElement('iframe')
    iframe.className = 'doc-preview-frame'
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
    iframe.src = apiBase + '/raw/' + filePath
    iframe.addEventListener('load', () => {
      try {
        const doc = iframe.contentDocument
        if (!doc) return
        doc.addEventListener('click', (ev) => {
          let el = ev.target
          while (el && el.tagName !== 'A') el = el.parentElement
          if (!el) return
          const raw = el.getAttribute('href')
          if (raw == null || raw === '') return
          // In-page anchor: let the iframe handle it natively.
          if (raw.charAt(0) === '#') return
          let url
          try {
            url = new URL(raw, iframe.contentWindow.location.href)
          } catch {
            return
          }
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            if (isSameOrigin(url) && url.pathname.indexOf('/raw/') !== -1) {
              ev.preventDefault()
              handleInternalLink(url.pathname + url.search + url.hash, filePath, onNavigate)
            } else {
              // External — open in a new tab, never navigate the tool away.
              ev.preventDefault()
              window.open(url.href, '_blank', 'noopener')
            }
          }
        }, true)
      } catch {
        // contentDocument blocked — links just work as their default.
      }
    })
    container.appendChild(iframe)
  }

  async function renderMarkdownPreview(opts, container) {
    const { filePath, apiBase, onNavigate } = opts
    const resp = await fetch(apiBase + '/raw/' + filePath)
    if (!resp.ok) throw new Error('markdown fetch failed: ' + resp.status)
    const text = await resp.text()
    const wrap = document.createElement('div')
    wrap.className = 'doc-preview md-preview'
    wrap.innerHTML = marked.parse(text, { breaks: true, gfm: true })

    const baseDir = dirOf(filePath)

    // Rewrite relative image sources to the /raw/ endpoint.
    wrap.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      if (!src) return
      if (/^(https?:|data:|\/)/i.test(src)) return
      img.setAttribute('src', apiBase + '/raw/' + resolveRelative(baseDir, src))
    })

    // Wire links: internal -> navigate, external -> new tab, #anchor -> scroll.
    wrap.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href')
      if (!href) return
      a.addEventListener('click', (ev) => {
        if (href.charAt(0) === '#') {
          ev.preventDefault()
          const target = wrap.querySelector(href) || wrap.querySelector('[id="' + href.slice(1) + '"]')
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
          return
        }
        let url = null
        try {
          url = new URL(href, window.location.href)
        } catch {
          url = null
        }
        const isExternal = url && (url.protocol === 'http:' || url.protocol === 'https:') &&
          !(isSameOrigin(url) && url.pathname.indexOf('/raw/') !== -1)
        if (isExternal) {
          ev.preventDefault()
          window.open(url.href, '_blank', 'noopener')
          return
        }
        // Internal workspace file (relative, or under /raw/).
        ev.preventDefault()
        handleInternalLink(href, filePath, onNavigate)
      })
    })

    // Optionally syntax-highlight fenced code blocks.
    if (typeof hljs !== 'undefined') {
      wrap.querySelectorAll('pre code').forEach((block) => {
        try {
          hljs.highlightElement(block)
        } catch {
          /* ignore highlight failures */
        }
      })
    }

    container.appendChild(wrap)
  }

  function renderImagePreview(opts, container) {
    const { filePath, apiBase } = opts
    const box = document.createElement('div')
    box.className = 'doc-preview img-preview'
    const img = document.createElement('img')
    img.src = apiBase + '/raw/' + filePath
    img.style.maxWidth = '100%'
    box.appendChild(img)
    container.appendChild(box)
  }

  async function renderPreview(opts) {
    const { kind, container } = opts
    try {
      container.innerHTML = ''
      if (kind === 'html') {
        renderHtmlPreview(opts, container)
      } else if (kind === 'markdown') {
        await renderMarkdownPreview(opts, container)
      } else if (kind === 'image') {
        renderImagePreview(opts, container)
      } else {
        throw new Error('unpreviewable kind: ' + kind)
      }
    } catch (err) {
      // Re-throw so the caller falls back to the raw source view.
      throw err
    }
  }

  window.ArgoPreview = {
    previewKindFor,
    hasToggle,
    getMode,
    setMode,
    renderPreview,
    handleInternalLink,
    dirOf,
    resolveRelative,
  }
})()
