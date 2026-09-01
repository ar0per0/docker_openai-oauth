#!/bin/sh
set -eu

LOGIN_MODE="${LOGIN_MODE:-device}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-10531}"
MODEL_TEST="${MODEL_TEST:-}"
CRON_TEST="${CRON_TEST:-}"
HEALTHCHECK_TIMEOUT_MS="${HEALTHCHECK_TIMEOUT_MS:-30000}"

case "$PORT" in
    ''|*[!0-9]*)
        echo "[openai-oauth] ERROR: PORT debe ser un entero entre 1 y 65535." >&2
        exit 2
        ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "[openai-oauth] ERROR: PORT debe ser un entero entre 1 y 65535." >&2
    exit 2
fi

case "$HEALTHCHECK_TIMEOUT_MS" in
    ''|*[!0-9]*)
        echo "[openai-oauth] ERROR: HEALTHCHECK_TIMEOUT_MS debe ser un entero positivo." >&2
        exit 2
        ;;
esac
if [ "$HEALTHCHECK_TIMEOUT_MS" -lt 1 ]; then
    echo "[openai-oauth] ERROR: HEALTHCHECK_TIMEOUT_MS debe ser un entero positivo." >&2
    exit 2
fi

if [ -n "${AUTH_FILE:-}" ]; then
    CODEX_HOME="$(dirname "$AUTH_FILE")"
else
    CODEX_HOME="${CODEX_HOME:-/data/codex}"
    AUTH_FILE="$CODEX_HOME/auth.json"
fi
export CODEX_HOME AUTH_FILE

mkdir -p "$CODEX_HOME"

echo "[openai-oauth] Auth file: $AUTH_FILE"
echo "[openai-oauth] Login mode: $LOGIN_MODE"

if [ ! -s "$AUTH_FILE" ]; then
    case "$LOGIN_MODE" in
        device)
            echo "[openai-oauth] No existe auth.json; iniciando device-auth..."
            codex login --device-auth
            ;;
        browser)
            echo "[openai-oauth] No existe auth.json; iniciando login web..."
            echo "[openai-oauth] Abre manualmente la URL que aparecerá a continuación."
            echo "[openai-oauth] El callback se recibirá en http://localhost:1455/auth/callback"
            openai-oauth login \
                --no-open \
                --oauth-file "$AUTH_FILE"
            ;;
        *)
            echo "[openai-oauth] ERROR: LOGIN_MODE debe ser 'device' o 'browser'." >&2
            exit 2
            ;;
    esac

    if [ ! -s "$AUTH_FILE" ]; then
        echo "[openai-oauth] ERROR: el login terminó pero no se creó $AUTH_FILE" >&2
        exit 1
    fi

    echo "[openai-oauth] Login completado correctamente."
else
    echo "[openai-oauth] auth.json encontrado; se omite el login."
fi

if [ -n "$CRON_TEST" ]; then
    if [ -n "$MODEL_TEST" ] && ! printf '%s\n' "$MODEL_TEST" | grep -Eq '^[A-Za-z0-9._:-]+$'; then
        echo "[openai-oauth] ERROR: MODEL_TEST contiene caracteres no válidos." >&2
        exit 2
    fi

    CRON_FILE=/etc/cron.d/openai-oauth-health
    printf 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nMAILTO=""\n' > "$CRON_FILE"
    CRON_COUNT=0

    # Separar expresiones por "|" sin expandir posibles comodines del cron.
    set -f
    OLD_IFS=$IFS
    IFS='|'
    set -- $CRON_TEST
    IFS=$OLD_IFS
    set +f

    for CRON_EXPRESSION in "$@"; do
        CRON_EXPRESSION="$(printf '%s' "$CRON_EXPRESSION" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        if [ -z "$CRON_EXPRESSION" ] || \
           ! printf '%s\n' "$CRON_EXPRESSION" | grep -Eq '^[0-9*/, -]+$' || \
           [ "$(printf '%s\n' "$CRON_EXPRESSION" | awk '{print NF}')" -ne 5 ]; then
            echo "[openai-oauth] ERROR: expresión cron no válida: '$CRON_EXPRESSION'" >&2
            exit 2
        fi

        printf '%s root PORT=%s MODEL_TEST=%s HEALTHCHECK_TIMEOUT_MS=%s /usr/local/bin/node /usr/local/lib/openai-oauth-healthcheck.mjs >> /proc/1/fd/1 2>> /proc/1/fd/2\n' \
            "$CRON_EXPRESSION" "$PORT" "$MODEL_TEST" "$HEALTHCHECK_TIMEOUT_MS" >> "$CRON_FILE"
        CRON_COUNT=$((CRON_COUNT + 1))
        echo "[openai-oauth] Cron añadido: $CRON_EXPRESSION"
    done

    chmod 0644 /etc/cron.d/openai-oauth-health
    cron
    echo "[openai-oauth] Comprobaciones cron activadas: $CRON_COUNT"
else
    echo "[openai-oauth] Comprobación cron desactivada."
fi

echo "[openai-oauth] Arrancando servicio en ${HOST}:${PORT}..."

set -- openai-oauth \
    --host "$HOST" \
    --port "$PORT" \
    --oauth-file "$AUTH_FILE"

exec "$@"
