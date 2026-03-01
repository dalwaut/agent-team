# OPAI Dev — Custom Theia IDE Image
# Builds Theia from npm packages (not from monorepo clone).
#
# Build:   docker build -t opai-theia:latest -f docker/Dockerfile docker/
# Run:     docker run -d -p 9000:3000 -v /path/to/workspace:/home/project opai-theia:latest

# ── Stage 1: Build Theia ──────────────────────────────────
FROM node:22-bookworm AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc pkg-config \
    libxkbfile-dev libsecret-1-dev libkrb5-dev \
    libudev-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/theia

# Copy the Theia app package.json (defines extensions + plugins)
COPY theia-app.json ./package.json

# Install (with native module compilation), build, download plugins, prune
RUN npm install \
    && NODE_OPTIONS="--max_old_space_size=4096" npx theia build --mode production \
    && npx theia download:plugins --ignore-errors \
    && npm prune --production \
    && npm cache clean --force

# ── Stage 2: Runtime ──────────────────────────────────────
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Runtime dependencies (socat bridges Unix socket to TCP for Theia AI)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential python3 procps sudo \
    openssh-client bash libsecret-1-0 socat \
    && rm -rf /var/lib/apt/lists/*

# Create non-root developer user
RUN groupadd -g 1001 developer \
    && useradd -m -u 1001 -g developer -s /bin/bash developer \
    && echo "developer ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/developer

# Copy built Theia
WORKDIR /home/theia
COPY --from=builder --chown=developer:developer /home/theia /home/theia

# Copy branding
COPY branding/product.json /home/theia/product.json

# Create workspace directory and user-plugins mount point
RUN mkdir -p /home/project /home/theia/user-plugins \
    && chown developer:developer /home/project /home/theia/user-plugins

USER developer

# Default Theia settings (dark theme, AI enabled, editor defaults)
COPY --chown=developer:developer default-settings.json /home/developer/.theia/settings.json

# OPAI custom plugin (auto-opens AI Chat panel)
COPY --chown=developer:developer plugins/opai-ai-defaults /home/theia/plugins/opai-ai-defaults

# Container entrypoint (starts socat proxy + Theia)
COPY --chown=developer:developer entrypoint.sh /home/theia/entrypoint.sh

EXPOSE 3000

ENV HOME=/home/developer
ENV SHELL=/bin/bash
ENV THEIA_DEFAULT_PLUGINS=local-dir:/home/theia/plugins
ENV USE_LOCAL_GIT=true
ENV NODE_PATH=/home/theia/node_modules

ENTRYPOINT ["/home/theia/entrypoint.sh"]
CMD ["/home/project", "--hostname=0.0.0.0"]
