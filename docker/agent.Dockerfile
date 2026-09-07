# ── Stage 1: compile TypeScript ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY src/ ./src/
COPY tsconfig.json ./
RUN node node_modules/typescript/bin/tsc

# ── Stage 2: runtime ─────────────────────────────────────────────
FROM ubuntu:24.04

# Weekly cache-bust for the download-heavy layers below. `argo rebuild` passes
# --build-arg CACHE_WEEK=<epoch-week> (an integer that increments every 7 days).
# It is referenced in the first download layer, so Docker reuses the cached
# apt / Node / npm / Chromium layers for every rebuild within the same week and
# only re-downloads them once the week rolls over. Crucially, ALL app code (the
# COPY layers) is placed AFTER these download layers, so an ordinary code
# rebuild reuses every download and fetches nothing over the network — only the
# cheap COPY-from-builder layers (local, no download) are rebuilt.
ARG CACHE_WEEK=0

# System packages
RUN echo "system deps — cache week ${CACHE_WEEK}" \
  && apt-get update && apt-get install -y \
  bash curl wget git jq \
  unzip zip pv tree file \
  ripgrep fd-find \
  sqlite3 miller parallel \
  dnsutils netcat-openbsd iputils-ping \
  ca-certificates gnupg \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Node.js 22 (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Sandbox npm packages (available via NODE_PATH for agent-written scripts)
RUN mkdir -p /usr/local/lib/agent-tools \
  && cd /usr/local/lib/agent-tools \
  && npm init -y \
  && npm install \
    playwright \
    cheerio \
    js-yaml \
    csv-parse \
    xlsx \
    pdf-parse \
    marked \
    turndown \
    handlebars \
    chalk \
    commander \
    date-fns \
    iconv-lite \
    glob

ENV NODE_PATH=/usr/local/lib/agent-tools/node_modules

# Playwright Chromium (the largest download — kept above the app COPYs so a code
# rebuild never re-fetches it)
RUN cd /usr/local/lib/agent-tools && npx playwright install --with-deps chromium

# Git config
RUN git config --global user.email "agent@local" \
  && git config --global user.name "Local Agent" \
  && git config --global init.defaultBranch main

# ── App code — changes on every build, so it comes LAST. Only these layers are
#    rebuilt on a normal `argo rebuild`, and they copy locally from the builder
#    stage (no network). node_modules is copied before dist so a code-only change
#    (dist/public) leaves the larger node_modules layer cached. ───────────────
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY public/ ./public/

ENV RUNNING_IN_CONTAINER=1
ENV WORKER_MODE=1
ENV PORT=3000

EXPOSE 3000
WORKDIR /workspace
CMD ["node", "/app/dist/index.js"]
