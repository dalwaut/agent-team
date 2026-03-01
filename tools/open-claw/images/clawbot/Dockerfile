# OpenClaw ClawBot Base Image
# Minimal Node.js runtime for autonomous agent containers.
# The actual bot logic is mounted via volumes (config/, knowledge/, workspace/).
# This image provides the runtime skeleton + health endpoint.

FROM node:20-alpine

LABEL org.opencontainers.image.title="ClawBot" \
      org.opencontainers.image.description="OpenClaw autonomous agent container" \
      org.opencontainers.image.vendor="OPAI"

# Security: run as non-root
RUN addgroup -S clawbot && adduser -S clawbot -G clawbot

WORKDIR /app

# Install base dependencies
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Copy runtime files
COPY server.js ./
COPY lib/ ./lib/

# Create required dirs (volumes mount over these)
RUN mkdir -p /app/config /app/knowledge /app/logs /app/workspace /app/tmp \
    && chown -R clawbot:clawbot /app

USER clawbot

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
