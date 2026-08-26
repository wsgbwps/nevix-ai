#!/bin/sh
# TLS certificate lifecycle for the official public Nevix deployment
# (issue #152, ADR-0013).
#
# First boot mints a five-year self-signed certificate that carries the
# deployment's fixed public IP in its subjectAltName; every later start
# validates and reuses the persisted pair. Rotation is NEVER automatic: a
# fresh certificate is only minted when the tls volume has no pair at all, or
# when the operator explicitly forces rotation with CERT_FORCE_NEW=true —
# every fingerprint change requires all Desktops to re-confirm trust (TOFU),
# so no code path may replace the identity on its own. A persisted pair that
# is corrupt, mismatched, expired, or no longer matches the configured public
# IP fails closed with the rotation command; the stack then refuses to start
# its edge until an operator decides.
#
# CERT_MODE=init   one-shot provisioning (compose service cert-init)
# CERT_MODE=watch  daily loop that keeps the <90-day expiry warning visible
#                  in operations logs (compose service cert-watch)
set -eu

CERT_DIR="${CERT_DIR:-/etc/nginx/tls}"
CERT_FILE="$CERT_DIR/server.pem"
KEY_FILE="$CERT_DIR/server.key"
PUBLIC_IP="${NEVIX_PUBLIC_IP:-}"
MODE="${CERT_MODE:-init}"
FORCE_NEW="${CERT_FORCE_NEW:-false}"
EXPIRY_ALERT_DAYS="${CERT_EXPIRY_ALERT_DAYS:-90}"
VALIDITY_DAYS=1826 # five years

log() { echo "cert-init: $*"; }

fail() {
  echo "cert-init: $*" >&2
  exit 1
}

require_public_ip() {
  case "$PUBLIC_IP" in
    "" | *[!0-9A-Fa-f:.]*) fail "NEVIX_PUBLIC_IP must be set to the deployment's fixed public IP (IPv4 or IPv6)" ;;
  esac
}

fingerprint() {
  openssl x509 -in "$CERT_FILE" -noout -fingerprint -sha256 | cut -d= -f2
}

report_fingerprint() {
  log "certificate SHA-256 fingerprint: $(fingerprint)"
  log "repeatable query: docker compose exec cert-watch openssl x509 -in $CERT_FILE -noout -fingerprint -sha256"
}

# The 90-day alert (acceptance criterion): printed on every provisioning run
# and once a day by cert-watch while the window is open, so the warning stays
# visible in `docker compose logs cert-watch` instead of firing once.
expiry_warning() {
  if ! openssl x509 -in "$CERT_FILE" -noout -checkend $((EXPIRY_ALERT_DAYS * 86400)) >/dev/null; then
    end_date="$(openssl x509 -in "$CERT_FILE" -noout -enddate | cut -d= -f2)"
    echo "cert-init: WARNING: certificate expires within ${EXPIRY_ALERT_DAYS} days (on ${end_date}); plan an explicit rotation — see deploy/README.md" >&2
    return 1
  fi
  return 0
}

certificate_pubkey_digest() {
  openssl x509 -in "$CERT_FILE" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | openssl sha256 | awk '{print $2}'
}

private_key_pubkey_digest() {
  openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | openssl sha256 | awk '{print $2}'
}

# A persisted pair is reusable only when both halves parse, the key owns the
# certificate's public key, the certificate is live, and its SAN still names
# the configured public IP. Any other state is an explicit-stop condition:
# the operator rotates with CERT_FORCE_NEW=true (deploy/README.md §4).
pair_is_valid() {
  openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1 || {
    refuse_reuse "the persisted certificate is unreadable or corrupt"
  }
  openssl pkey -in "$KEY_FILE" -noout >/dev/null 2>&1 || {
    refuse_reuse "the persisted private key is unreadable or corrupt"
  }
  if [ "$(certificate_pubkey_digest)" != "$(private_key_pubkey_digest)" ]; then
    refuse_reuse "the persisted certificate and private key do not match"
  fi
  openssl x509 -in "$CERT_FILE" -noout -checkend 0 >/dev/null 2>&1 || {
    refuse_reuse "the persisted certificate has expired (the 90-day warning was the rotation signal)"
  }
  # "does match" (never the negated "does not match") is the stable success
  # phrase for openssl x509 -checkip output.
  openssl x509 -in "$CERT_FILE" -noout -checkip "$PUBLIC_IP" 2>/dev/null | grep -q "does match certificate" || {
    refuse_reuse "the configured public IP ($PUBLIC_IP) is not in the persisted certificate SAN (the deployment IP changed)"
  }
  return 0
}

refuse_reuse() {
  echo "cert-init: refusing to touch the persisted certificate: $1" >&2
  echo "cert-init: an existing TLS identity is only replaced by an explicit operator decision — every Desktop must re-confirm trust (TOFU) after rotation" >&2
  echo "cert-init: to rotate now: docker compose run --rm -e CERT_FORCE_NEW=true cert-init && docker compose restart nginx" >&2
  exit 1
}

generate_certificate() {
  # umask 077 keeps the fresh key private before chmod applies; the files are
  # written under temporary names and moved into place so a crash never leaves
  # a half-written pair that a later start would treat as reusable.
  umask 077
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$KEY_FILE.new" -out "$CERT_FILE.new" \
    -days "$VALIDITY_DAYS" -sha256 \
    -subj "/CN=nevix-$PUBLIC_IP" \
    -addext "subjectAltName=IP:$PUBLIC_IP" \
    >/dev/null 2>&1
  chmod 600 "$KEY_FILE.new"
  chmod 644 "$CERT_FILE.new"
  mv "$KEY_FILE.new" "$KEY_FILE"
  mv "$CERT_FILE.new" "$CERT_FILE"
}

case "$MODE" in
  init)
    require_public_ip

    if [ "$FORCE_NEW" = "true" ]; then
      echo "cert-init: explicit rotation requested (CERT_FORCE_NEW=true); generating a replacement certificate — distribute the new SHA-256 fingerprint, every Desktop must re-confirm trust (TOFU)" >&2
      generate_certificate
      report_fingerprint
      exit 0
    fi

    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
      pair_is_valid
      log "reusing persisted certificate (restarts and upgrades never rotate silently)"
      report_fingerprint
      expiry_warning || true
      exit 0
    fi

    if [ -e "$CERT_FILE" ] || [ -e "$KEY_FILE" ]; then
      # Half a persisted pair is damage, not emptiness: minting over it would
      # replace an existing TLS identity without an operator decision.
      refuse_reuse "the persisted pair is incomplete (only one of certificate/key exists)"
    fi

    log "no persisted certificate found; generating the first one for public IP $PUBLIC_IP"
    generate_certificate
    report_fingerprint
    ;;
  watch)
    # Keep the expiry warning visible daily. Reuse problems are NOT repaired
    # here: regeneration always runs through cert-init so every rotation is a
    # logged provisioning event.
    if [ ! -f "$CERT_FILE" ]; then
      fail "no certificate present; run the cert-init service"
    fi
    while :; do
      if expiry_warning; then
        log "certificate healthy (checked today)"
      fi
      sleep 86400
    done
    ;;
  *)
    fail "unknown CERT_MODE: $MODE (expected init or watch)"
    ;;
esac
