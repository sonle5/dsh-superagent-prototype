#!/bin/sh
set -eu

ENV_FILE=${DSH_SUPERAGENT_TLS_ENV:-/etc/dsh-superagent/tls.env}
. "$ENV_FILE"

: "${DSH_TLS_CERT_SOURCE:?DSH_TLS_CERT_SOURCE is required}"
: "${DSH_TLS_KEY_SOURCE:?DSH_TLS_KEY_SOURCE is required}"
: "${DSH_TLS_OWNER:?DSH_TLS_OWNER is required}"
: "${DSH_TLS_GROUP:?DSH_TLS_GROUP is required}"
: "${DSH_TLS_GATEWAY_UNIT:?DSH_TLS_GATEWAY_UNIT is required}"
DSH_TLS_DIR=${DSH_TLS_DIR:-/etc/dsh-superagent/tls}

install -d -o "$DSH_TLS_OWNER" -g "$DSH_TLS_GROUP" -m 0750 "$DSH_TLS_DIR"
install -o "$DSH_TLS_OWNER" -g "$DSH_TLS_GROUP" -m 0640 \
  "$DSH_TLS_CERT_SOURCE" "$DSH_TLS_DIR/cert.pem"
install -o "$DSH_TLS_OWNER" -g "$DSH_TLS_GROUP" -m 0640 \
  "$DSH_TLS_KEY_SOURCE" "$DSH_TLS_DIR/key.pem"
exec systemctl restart "$DSH_TLS_GATEWAY_UNIT"
