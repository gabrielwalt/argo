FROM ubuntu:24.04

# ── System packages ──────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
  \
  # Shell essentials
  bash curl wget git jq \
  unzip zip \
  pv \
  tree \
  file \
  \
  # Fast search / file finding
  ripgrep fd-find \
  \
  # Data & databases
  sqlite3 \
  miller \
  \
  # Batch processing
  parallel \
  \
  # Network debugging
  dnsutils \
  netcat-openbsd \
  iputils-ping \
  \
  # Node.js setup deps
  ca-certificates gnupg \
  \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 (LTS) ─────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# ── npm packages ─────────────────────────────────────────────────
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

# ── Playwright Chromium ──────────────────────────────────────────
RUN cd /usr/local/lib/agent-tools && npx playwright install --with-deps chromium

# ── Git config ───────────────────────────────────────────────────
RUN git config --global user.email "agent@local" && \
    git config --global user.name "Local Agent" && \
    git config --global init.defaultBranch main

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
