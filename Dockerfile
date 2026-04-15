# syntax=docker/dockerfile:1.7
# Multi-stage build for Glassmkr Crucible monitoring agent.

# ---------- Stage 1: build TypeScript to dist/ ----------
FROM node:24-slim AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: production runtime ----------
FROM node:24-slim AS runtime

# Hardware monitoring tools. Crucible shells out to these; they must be on PATH.
RUN apt-get update && apt-get install -y --no-install-recommends \
    smartmontools \
    ipmitool \
    dmidecode \
    lm-sensors \
    ethtool \
    util-linux \
    procps \
    net-tools \
    iproute2 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production node_modules only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Built code.
COPY --from=builder /build/dist ./dist

# Create a non-root user for future use. IPMI and SMART typically require root,
# so the container is expected to run with --privileged or cap_add DAC_READ_SEARCH etc.
# Keeping the user available lets operators drop privileges when hardware access is not needed.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin glassmkr

# Crucible reads /etc/glassmkr/collector.yaml by default.
# Mount the host config directory at this path.
RUN mkdir -p /etc/glassmkr

# Container health: verify the Node process is actually running and hasn't crashed.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD pgrep -f "node /app/dist/index.js" > /dev/null || exit 1

LABEL org.opencontainers.image.source="https://github.com/glassmkr/crucible" \
      org.opencontainers.image.description="Glassmkr Crucible - bare metal server monitoring agent" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="Crucible" \
      org.opencontainers.image.vendor="Glassmkr"

# Crucible does not listen on any port; data flows outbound to Forge.
ENTRYPOINT ["node", "/app/dist/index.js"]
