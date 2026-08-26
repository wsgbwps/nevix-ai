#!/bin/sh
# First-boot credential provisioning for the bundled PostgreSQL (issue #152,
# ADR-0013/0015): the goose migrations create the identity_app LOGIN role
# WITHOUT a password because deployment provisioning — not the schema — owns
# credentials. This script runs once, when the pgdata volume is still empty
# (docker-entrypoint-initdb.d semantics), and creates the role with the
# deployment password so the Go server's DATABASE_URL can authenticate.
# Later boots adopt the existing role and never reset its password; rotate
# credentials explicitly with ALTER ROLE (see deploy/README.md).
set -eu

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" \
  -v identity_password="${NEVIX_IDENTITY_APP_PASSWORD:?NEVIX_IDENTITY_APP_PASSWORD is required}" <<-EOSQL
    SELECT format('CREATE ROLE identity_app LOGIN PASSWORD %L', :'identity_password')
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app')\gexec
EOSQL

echo "postgres-init: identity_app role ready (created with deployment password or already present)"
