# ── Stage 1: compile TypeScript ──────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc

# ── Stage 2: runtime ─────────────────────────────────────────────
FROM ubuntu:24.04

# System packages
RUN apt-get update && apt-get install -y \
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

# Agent server
WORKDIR /app
COPY --from=builder /app/dist       ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY public/ ./public/

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

# Playwright Chromium
RUN cd /usr/local/lib/agent-tools && npx playwright install --with-deps chromium

# Git config
RUN git config --global user.email "agent@local" \
  && git config --global user.name "Local Agent" \
  && git config --global init.defaultBranch main

ENV RUNNING_IN_CONTAINER=1
ENV WORKER_MODE=1
ENV PORT=3000

EXPOSE 3000
WORKDIR /workspace
CMD ["node", "/app/dist/index.js"]
