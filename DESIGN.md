# Argo — Design System

> *"Simplicity is elegant and the ultimate sophistication."*

Argo is a local LLM coding agent. Its visual identity draws from the mythological ship — a vessel of prophetical quests, navigating the technical singularity through dark waters with a golden compass. The aesthetic is dark-technical: precise, alive, quietly confident. No decoration for its own sake. Every effect must earn its place.

---

## Brand concept

**The myth:** The Argo carried Jason and the Argonauts on a prophetical quest. Here it carries your code through files, folders, and AI-generated transformations.

**The tone:** Not flashy. Not corporate. Scientific-mystical. A terminal that whispers.

**The principle:** The interface recedes so the work is foregrounded. Gold signals where attention belongs. Everything else is ink.

---

## Color system

### Core palette

```
--bg:          #090b12   Deep space — page background
--surface:     #111520   Elevated surface — cards, panels, header
--border:      #1e2235   All borders and dividers
--text:        #e2e4f0   Primary readable text
--muted:       #565e7a   Labels, metadata, secondary text
```

### Brand gold

Gold is Argo's singular brand accent. It marks identity, active state, CTAs, and the boat.

```
--gold:        #c9a227   Core gold
               #f0d478   Highlight band (in gradients)
               #fffde8   Specular peak (in send button gradient)
--gold-glow:   rgba(201, 162, 39, 0.18–0.20)   Soft glow, halos
```

**Gold gradient (wordmark + boat):**
```css
linear-gradient(90deg, #c9a227 0%, #f0d478 45%, #c9a227 90%)
background-size: 200% auto;
animation: gold-shimmer 8s linear infinite;
```

**Gold gradient (send button — coin shine):**
```css
linear-gradient(105deg, #c9a227 0%, #e0b830 28%, #f7e27c 45%, #fffde8 50%, #f7e27c 55%, #e0b830 72%, #c9a227 100%)
background-size: 300% 100%;
```

**Gold tint for surfaces:** `rgba(201, 162, 39, 0.05–0.12)` — used in session banners, CTA rows, hover states.

### UI accent

```
--accent:      #5b67f5   Indigo — interactive elements, user messages, links
--accent-dim:  #2a2f6b   Dimmed indigo for backgrounds
```

### Semantic colors

Used exclusively for status indicators — never decoratively.

```
--green:  #22c55e   Success, running, done
--yellow: #eab308   Warning, in-progress
--red:    #ef4444   Error, destructive actions
--blue:   #3b82f6   Directories, links, info
--orange: #f97316   (reserved)
--purple: #a855f7   Iteration markers
```

### Background gradient

Applied to `body` only. Subtle ambient light, never overwhelming:

```css
background-image:
  radial-gradient(ellipse 70% 50% at 10% 0%,   rgba(91, 103, 245, 0.06) 0%, transparent 100%),
  radial-gradient(ellipse 50% 40% at 90% 100%,  rgba(201, 162, 39, 0.04) 0%, transparent 100%);
```

Left-top: faint indigo (accent nebula). Bottom-right: faint gold (horizon glow).

---

## Typography

### Font stacks

```css
/* UI text — all prose, labels, messages */
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

/* Code, paths, metadata, trace output */
font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
--font-mono: (CSS variable)
```

### Scale

| Role | Size | Weight | Family |
|---|---|---|---|
| Wordmark (Argo) | 15–20px | 600 | System sans |
| Body text | 14px | 400 | System sans |
| UI labels | 12–13px | 400–500 | System sans or mono |
| Metadata, timestamps | 11–12px | 400 | Mono |
| Section headers | 10–13px | 600 | System sans |
| Uppercase labels | 10–11px | 600, letter-spacing .06–.07em | System sans |

### Rules

- **Monospace for everything technical:** file paths, timestamps, model names, tool names, tokens, git hashes, setting values.
- **Uppercase + letter-spacing for section labels:** `font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);`
- Never mix weights within the same line element.
- Gold text (`color: var(--gold)`) marks active or selected state — not purely decorative.

---

## The Argo mark

### The boat

The sailing boat ⛵ is Argo's sole pictorial icon. Rules:

1. **Always gold.** In the workspace homepage, it is a standalone `<span>`, never nested inside a gradient text element. In the header send button, it uses `filter: brightness(0)` (black silhouette on the gold button). Never rendered in a neutral or muted color independently.
2. **Always sailing right.** Apply `transform: scaleX(-1)` to flip the emoji so it faces right. This is non-negotiable and semantic — the ship is always moving forward.
3. **Always `display: inline-block`.** Required for `transform` to apply.
4. **Size relative to context:**
   - Homepage header: `font-size: 26px`
   - Send button: `font-size: 17px` inside a 38×38px circle
   - Never smaller than 14px

### The wordmark

"Argo" in the header/nav is rendered with the animated gold shimmer gradient:

```css
background: linear-gradient(90deg, var(--gold) 0%, #f0d478 45%, var(--gold) 90%);
background-size: 200% auto;
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
background-clip: text;
animation: gold-shimmer 8s linear infinite;
```

**Critical:** Any element containing `.flip-h` (the flipped boat) inside a gradient-text link must re-declare the gradient on the child. `-webkit-text-fill-color: transparent` breaks emoji rendering on nested `inline-block` elements — it makes them invisible. The emoji must be a sibling element, not a child.

### Combined mark (homepage header)

```html
<header>
  <span class="logo">⛵</span>    <!-- standalone, always gold -->
  <h1>Argo</h1>                   <!-- shimmer gradient wordmark -->
  <span class="subtitle">Navigate your workspaces</span>
</header>
```

Layout: `display: flex; align-items: center; gap: 16px;`

The logo and wordmark are **visually aligned to center** — never baseline. Gap is always 16px between logo and title, 12–16px between title and subtitle.

### Navigation header mark

In the agent UI header: `<a id="nav-home">⛵ Argo</a>` with shimmer gradient and `font-size: 15px; font-weight: 600`.

---

## Spacing system

Base unit: **4px**. All spacing is a multiple of 4.

| Token | Value | Use |
|---|---|---|
| `space-1` | 4px | Tight: icon gaps, badge padding |
| `space-2` | 8px | Default gap inside components |
| `space-3` | 12px | Component internal padding |
| `space-4` | 16px | Section internal padding |
| `space-5` | 20px | Component external margins |
| `space-6` | 24px | Group separation |
| `space-8` | 32px | Section separation |
| `space-9` | 36px | Major section separation |
| `space-10` | 40px | Page-level margins |
| `space-12` | 48px | Page padding top |

### Fixed heights

| Element | Height |
|---|---|
| Header bar | 42px |
| Tab bar | ~38px (8px pad top+bottom + content) |
| Settings panel (open) | 56px max |
| Dropdown item row | ~30–32px (7px pad top+bottom) |
| CTA dropdown row | ~36px (9px top, 10px bottom) |

---

## Border radius

| Context | Radius |
|---|---|
| Micro (badges, status pills) | 3px |
| Controls (buttons, inputs, dropdowns) | 4px |
| Cards and small modals | 6–8px |
| Large cards and panels | 10px |
| Circular (status dot, send button) | 50% |

---

## Surfaces and elevation

Three layers, top-to-bottom:

| Layer | Color | Border | Use |
|---|---|---|---|
| Base | `--bg` `#090b12` | — | Page background |
| Surface | `--surface` `#111520` | `1px solid var(--border)` | Cards, header, panels |
| Elevated | `--surface` + `box-shadow` | `1px solid var(--border)` | Dropdowns, modals |

### Borders

All borders are `1px solid var(--border)` (`#1e2235`). The only exception is the gold border used for focus states and hover highlights:

```css
/* Focus ring on inputs */
border-color: rgba(201, 162, 39, 0.45);
box-shadow: 0 0 0 2px rgba(201, 162, 39, 0.07);

/* Card hover (workspace, log entry) */
border-color: rgba(201, 162, 39, 0.45);
box-shadow: 0 0 20px rgba(201, 162, 39, 0.06);
```

### The header gold line

A subtle decorative flourish under the header — rendered via `::after`, opacity .2:

```css
header::after {
  content: '';
  position: absolute;
  bottom: -1px; left: 8%; right: 8%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
  opacity: .2;
}
```

This is the only "decorative" rule in the system. It is intentional and should not be replicated elsewhere.

---

## Animation system

Four animations. Use sparingly — motion must carry semantic meaning.

### `gold-shimmer` — 8s, infinite

Applied to: wordmark, nav-home link. Signals: brand identity, alive.

```css
@keyframes gold-shimmer {
  0%   { background-position: 0% center; }
  100% { background-position: 200% center; }
}
```

### `pulse-glow` — 1.4s, ease-in-out, infinite

Applied to: status dot when `busy`. Signals: agent is thinking.

```css
@keyframes pulse-glow {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: .4; transform: scale(.72); }
}
```

### `sail-away` — 0.45s, ease-in, forwards

Applied to: send button boat icon on submit. Signals: message sent, agent is launched.

```css
@keyframes sail-away {
  0%   { transform: scaleX(-1) translateX(0);     opacity: 1; }
  55%  { opacity: 0; }
  100% { transform: scaleX(-1) translateX(-32px); opacity: 0; }
}
```

### `msg-in` / `trace-in` — 0.15–0.2s, ease-out

Applied to: new chat messages, trace items. Signals: new content arrived.

```css
@keyframes msg-in   { from { opacity: 0; transform: translateY(5px); }  to { opacity: 1; transform: translateY(0); } }
@keyframes trace-in { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: translateX(0); } }
```

### `card-in` — 0.2s, ease-out, staggered

Applied to: workspace cards on homepage. Stagger: `nth-child(n) { animation-delay: n * 0.04s }`.

### Rules

- **No looping animations on content.** Only `gold-shimmer` and `pulse-glow` loop. Content animations are one-shot.
- **No transform on layout-critical elements.** Never animate width, height, or position in a way that causes reflow.
- **Transition duration:** UI micro-interactions use `0.15s`. Hover effects use `0.15–0.2s`. Structural transitions (panel open/close) use `0.15s ease`.

---

## Component patterns

### Buttons

Three archetypes:

**Primary (send, attach)** — gold fill, dark text, coin-shine hover:
```css
background: gold-coin-gradient;
color: #1a1000; /* near-black for contrast */
box-shadow: 0 2px 8px rgba(201,162,39,.4);
```

**Secondary (accent)** — indigo fill, white text:
```css
background: var(--accent);
color: #fff;
transition: opacity .15s;
```
Hover: `opacity: .85`. Disabled: `opacity: .4`.

**Ghost** — no fill, muted border, muted text:
```css
background: none;
border: 1px solid var(--border);
color: var(--muted);
```
Hover: `color: var(--text)`. Destructive hover: `color: var(--red); border-color: rgba(239,68,68,.35)`.

All buttons: `border-radius: 4–6px; font-size: 12–13px; font-weight: 500; cursor: pointer; transition: opacity .15s;`

### Inputs

```css
background: var(--bg);            /* one level below surface */
border: 1px solid var(--border);
color: var(--text);
border-radius: 4–6px;
font-family: var(--font-mono);    /* always mono for path/code inputs */
```

Focus: gold border + 2px gold glow ring. Placeholder: `color: var(--muted)`.

### Cards

Workspace card / log entry / recent card share the same base:

```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: 10px;
padding: 12–16px 18–20px;
display: flex; align-items: center; gap: 14–16px;
transition: border-color .2s, box-shadow .2s;
animation: card-in .2s ease-out both;
```

Hover: gold border tint + faint gold glow. Never change background on hover.

### Nav dropdowns

Always `position: fixed`. Coordinates set from `getBoundingClientRect()` in JS at open time. Never `position: absolute`.

```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: 8px;
padding: 4px 0;
box-shadow: 0 4px 12px rgba(0,0,0,.3);
z-index: 1000;
```

Dropdown CTA row (top action): gold text, `rgba(201,162,39,.06)` background, heavier padding (`9px 14px 10px`), bottom border separator.

### Status dot

7×7px circle, `border-radius: 50%`.

```
Idle:  --green  + box-shadow glow
Busy:  --gold   + pulse-glow animation
Error: --red    + red glow
```

### Trace items

Left-border color coding against `var(--surface)` background. Border-left: 3px solid.

```
thought:    --blue   / text: #93c5fd
tool-call:  --yellow / text: var(--yellow)
tool-result:--green  / text: #86efac
error:      --red    / text: #fca5a5
iteration:  --purple / text: var(--purple), font-size: 11px
git:        --gold   / text: var(--gold)
compact:    --accent / text: var(--accent)
```

---

## Interaction states

| State | Treatment |
|---|---|
| Default | As specified per component |
| Hover | Opacity change (.75–.85) OR subtle background tint (`rgba(255,255,255,.05)`) |
| Focus | Gold border + faint gold glow ring |
| Active / selected | `color: var(--gold)` |
| Disabled | `opacity: .35–.4; cursor: not-allowed` |
| Destructive hover | `color: var(--red)` + red border tint |

---

## What not to do

- **No `position: absolute` on nav dropdowns.** Chrome clips them at `overflow: hidden` ancestors.
- **No emoji inside gradient-text elements.** They become invisible. Always sever the emoji into a sibling element.
- **No new looping animations.** `gold-shimmer` and `pulse-glow` are the only permitted infinite loops.
- **No decorative gradients on content areas.** Gradients live only on: the wordmark, the send button, the body ambient overlay, the header underline.
- **No shadows on cards at rest.** Shadow appears only on modal overlays and the send button. Cards use border color change for hover feedback.
- **No color outside the palette for semantic states.** Always use `--green/yellow/red/blue/purple` from the defined system.
- **No new spacing values.** Round to the nearest multiple of 4.

---

## Implementation checklist (for new UI components)

- [ ] Background is `var(--bg)` or `var(--surface)` — never a new color
- [ ] Border is `1px solid var(--border)` — unless it's a gold focus/hover state
- [ ] Text is `var(--text)` for content, `var(--muted)` for metadata
- [ ] Gold (`var(--gold)`) used for active/selected state only — not decoration
- [ ] Monospace font used for all technical content (paths, values, IDs)
- [ ] Boat emoji faces right (`scaleX(-1)`) and is gold
- [ ] Animations are one-shot for content, only `gold-shimmer`/`pulse-glow` loop
- [ ] Spacing is a multiple of 4
- [ ] Border radius is from the defined set (3, 4, 6, 8, 10, 50%)
- [ ] No new CSS variables added without updating this document
