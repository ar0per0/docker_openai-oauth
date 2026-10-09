FROM node:22-bookworm-slim

ENV OPENAI_OAUTH_VERSION=2.0.0
ARG CODEX_VERSION=latest

# `codex login --device-auth` invokes curl to perform the device-code flow.
# Keep CA roots explicit as the OAuth and model-discovery endpoints are HTTPS.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates \
      cron \
      curl \
      tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund \
      "openai-oauth@${OPENAI_OAUTH_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
    && curl --version >/dev/null \
    && codex --version \
    && openai-oauth --help >/dev/null \
    && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/openai-oauth-entrypoint
COPY healthcheck.mjs /usr/local/lib/openai-oauth-healthcheck.mjs
COPY oauth-rate-limits.mjs /usr/local/lib/oauth-rate-limits.mjs
COPY patch-openai-oauth.mjs /usr/local/lib/patch-openai-oauth.mjs
COPY safety-patch-v1.mjs /usr/local/lib/safety-patch-v1.mjs
COPY safety-patch.mjs /usr/local/lib/safety-patch.mjs
COPY runtime-safety.mjs /usr/local/lib/runtime-safety.mjs
RUN node /usr/local/lib/patch-openai-oauth.mjs /usr/local/lib/node_modules/openai-oauth
RUN chmod 0755 /usr/local/bin/openai-oauth-entrypoint

ENV CODEX_HOME=/data/codex \
    AUTH_FILE=/data/codex/auth.json \
    LOGIN_MODE=device \
    MODEL_TEST= \
    CRON_TEST= \
    CRON_TEST_COUNT=1 \
    STARTUP_MODEL_TEST=false \
    HEALTHCHECK_TIMEOUT_MS=30000 \
    UPSTREAM_TIMEOUT_MS=30000 \
    TZ=Etc/UTC \
    HOST=127.0.0.1 \
    PORT=10531

VOLUME ["/data/codex"]
EXPOSE 10531 1455

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 4 \
      "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/openai-oauth-entrypoint"]
