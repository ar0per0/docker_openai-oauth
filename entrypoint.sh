#!/bin/sh
set -eu

LOGIN_MODE="${LOGIN_MODE:-device}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-10531}"
MODEL_TEST="${MODEL_TEST:-}"
CRON_TEST="${CRON_TEST:-}"
HEALTHCHECK_TIMEOUT_MS="${HEALTHCHECK_TIMEOUT_MS:-30000}"
TZ_VALUE="${TZ:-Etc/UTC}"

if ! printf '%s\n' "$TZ_VALUE" | grep -Eq '^[A-Za-z0-9_+:/.-]+$' || \
   [ "${TZ_VALUE#/}" != "$TZ_VALUE" ] || \
   printf '%s\n' "$TZ_VALUE" | grep -Fq '..' || \
   [ ! -f "/usr/share/zoneinfo/$TZ_VALUE" ]; then
    echo "[openai-oauth] ERROR: TZ debe ser una zona IANA válida instalada en /usr/share/zoneinfo (por ejemplo, Europe/Madrid)." >&2
    exit 2
fi
export TZ="$TZ_VALUE"

validate_cron_expression() {
    printf '%s\n' "$1" | awk '
        function valid_number(value, minimum, maximum) {
            return value ~ /^[0-9]+$/ && value + 0 >= minimum && value + 0 <= maximum
        }

        function valid_part(value, minimum, maximum, slash_count, slash, base, range_count, range, step) {
            slash_count = split(value, slash, "/")
            if (slash_count > 2 || slash[1] == "") return 0

            base = slash[1]
            if (slash_count == 2) {
                step = slash[2]
                if (step !~ /^[0-9]+$/ || step + 0 < 1) return 0
            }

            if (base == "*") return 1

            range_count = split(base, range, "-")
            if (range_count == 1) return valid_number(base, minimum, maximum)
            if (range_count != 2 ||
                !valid_number(range[1], minimum, maximum) ||
                !valid_number(range[2], minimum, maximum) ||
                range[1] + 0 > range[2] + 0) return 0

            return 1
        }

        function valid_field(value, minimum, maximum, count, items, item_index) {
            count = split(value, items, ",")
            if (count < 1) return 0
            for (item_index = 1; item_index <= count; item_index++) {
                if (!valid_part(items[item_index], minimum, maximum)) return 0
            }
            return 1
        }

        BEGIN {
            valid = 1
            minimum[1] = 0; maximum[1] = 59
            minimum[2] = 0; maximum[2] = 23
            minimum[3] = 1; maximum[3] = 31
            minimum[4] = 1; maximum[4] = 12
            minimum[5] = 0; maximum[5] = 7
        }

        NF != 5 { valid = 0; next }

        {
            for (field = 1; field <= 5; field++) {
                if (!valid_field($field, minimum[field], maximum[field])) valid = 0
            }
        }

        END { exit valid ? 0 : 1 }
    '
}

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
    printf 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nMAILTO=""\nTZ=%s\n' \
        "$TZ_VALUE" > "$CRON_FILE"
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
           ! validate_cron_expression "$CRON_EXPRESSION"; then
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
    echo "[openai-oauth] Comprobaciones cron activadas: $CRON_COUNT (TZ=$TZ_VALUE)"
else
    echo "[openai-oauth] Comprobación cron desactivada."
fi

echo "[openai-oauth] Arrancando servicio en ${HOST}:${PORT}..."

set -- openai-oauth \
    --host "$HOST" \
    --port "$PORT" \
    --oauth-file "$AUTH_FILE"

exec "$@"
