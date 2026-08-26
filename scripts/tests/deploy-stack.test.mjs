// Structural contract tests for the official public deployment stack
// (issue #152): they prove the delivery invariants that make this compose safe
// to expose on a fixed public IP — no host port besides nginx 443, digest-
// pinned images, forced setup code, forwarded-header hygiene, end-to-end
// streaming, and the self-signed certificate lifecycle (five years, IP SAN,
// 0600 key, SHA-256 fingerprint, 90-day alert, reuse without rotation).
//
// The suite is intentionally dependency-free: the CI harness job runs it
// without installing workspace dependencies, so the compose file is parsed by
// a strict subset parser below instead of a YAML library. The parser accepts
// exactly the shapes the delivery compose uses (block maps, block sequences
// of scalars, scalars with ${...} interpolation, and flow sequences of
// scalars) and throws on anything else, so an exotic construct fails loudly
// here instead of shipping unverified.
//
// Tests marked "runtime" additionally execute real Docker behavior (image
// build, certificate lifecycle, effective compose config). They skip with a
// reason when no Docker daemon is available — CI's fast harness job has no
// Docker; the local loop and release workflows run them for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deployDir = join(repoRoot, "deploy");
const readDeploy = (relative) => readFileSync(join(deployDir, relative), "utf8");

class ComposeParseError extends Error {}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Plain scalars may contain anything the delivery compose uses (colons in
// volume specs, ${...} interpolation, URL characters); only YAML constructs
// this parser does not model are rejected, and only when they lead the value.
function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") throw new ComposeParseError("empty scalar");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (/^[&*!>%@`]|^[{}[]/.test(text)) {
    throw new ComposeParseError(`unsupported scalar syntax: ${raw}`);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function splitFlowEntries(inner) {
  const entries = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const char of inner) {
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    if (char === "," && !inSingle && !inDouble) {
      entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  entries.push(current);
  return entries;
}

function parseFlowSequence(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlowEntries(inner).map((entry) => parseScalar(entry));
}

const isListItem = (text) => /^-($|\s)/.test(text);

// Parses the block starting at lines[index] whose entries sit at `indent`.
// Returns { value, index } with index pointing at the first line beyond the
// block. A map value on its own line recurses into the child indent.
function parseBlock(lines, index, indent) {
  const node = isListItem(lines[index].text) ? [] : {};
  const asSequence = Array.isArray(node);
  while (index < lines.length && lines[index].indent === indent) {
    const { text } = lines[index];
    if (isListItem(text)) {
      if (!asSequence) throw new ComposeParseError(`unexpected list item: ${text}`);
      const rest = text.replace(/^-\s+/, "");
      if (rest === "") {
        // Nested block under a dash is not used by the delivery compose.
        throw new ComposeParseError(`block list items are unsupported: ${text}`);
      }
      node.push(rest.startsWith("[") ? parseFlowSequence(rest) : parseScalar(rest));
      index += 1;
      continue;
    }
    if (asSequence) throw new ComposeParseError(`unexpected mapping entry: ${text}`);
    const separator = text.indexOf(":");
    if (separator === -1) throw new ComposeParseError(`not a mapping entry: ${text}`);
    const key = parseScalar(text.slice(0, separator));
    const rawValue = text.slice(separator + 1).trim();
    if (rawValue === "") {
      const childIndent = index + 1 < lines.length ? lines[index + 1].indent : -1;
      if (childIndent > indent) {
        const nested = parseBlock(lines, index + 1, childIndent);
        node[key] = nested.value;
        index = nested.index;
      } else {
        node[key] = null;
        index += 1;
      }
    } else if (rawValue.startsWith("[")) {
      node[key] = parseFlowSequence(rawValue);
      index += 1;
    } else {
      node[key] = parseScalar(rawValue);
      index += 1;
    }
  }
  return { value: node, index };
}

function parseCompose(text) {
  const lines = text
    .split("\n")
    .map((raw) => ({
      indent: raw.match(/^\s*/)[0].replace(/\t/g, "    ").length,
      text: stripComment(raw).trimEnd().replace(/^\s+/, ""),
    }))
    .filter((line) => line.text !== "" && line.text !== "---");
  const root = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent !== 0) {
      throw new ComposeParseError(`unexpected top-level indent: ${line.text}`);
    }
    const separator = line.text.indexOf(":");
    if (separator === -1) throw new ComposeParseError(`not a mapping entry: ${line.text}`);
    const key = parseScalar(line.text.slice(0, separator));
    const rawValue = line.text.slice(separator + 1).trim();
    if (rawValue !== "") {
      root[key] = rawValue.startsWith("[") ? parseFlowSequence(rawValue) : parseScalar(rawValue);
      index += 1;
    } else {
      const childIndent = index + 1 < lines.length ? lines[index + 1].indent : -1;
      if (childIndent <= 0) throw new ComposeParseError(`empty top-level value: ${key}`);
      const nested = parseBlock(lines, index + 1, childIndent);
      root[key] = nested.value;
      index = nested.index;
    }
  }
  return root;
}

const compose = parseCompose(readDeploy("docker-compose.yml"));
const services = compose.services;
const nginxConf = readDeploy(join("nginx", "nginx.conf"));
const certInit = readDeploy(join("cert-init", "cert-init.sh"));
const postgresInit = readDeploy(join("postgres", "init-identity-app.sh"));
const envExample = readDeploy(".env.example");

const nonEdgeServices = Object.keys(services).filter((name) => name !== "nginx");

test("the strict compose parser reads the delivery file", () => {
  assert.equal(compose.name, "nevix");
  assert.deepEqual(Object.keys(services).sort(), [
    "cert-init",
    "cert-watch",
    "nginx",
    "postgres",
    "server",
  ]);
  assert.equal(services.server.healthcheck.retries, 12);
  assert.deepEqual(services.nginx.ports, ["443:443"]);
  assert.equal(services.server.build.context, "../server");
});

test("only nginx publishes a host port, and it is 443", () => {
  for (const name of nonEdgeServices) {
    assert.equal(
      services[name].ports,
      undefined,
      `${name} must not publish host ports (internal network only)`
    );
    assert.equal(
      services[name].network_mode,
      undefined,
      `${name} must not use host networking`
    );
  }
  const published = services.nginx.ports;
  assert.equal(published.length, 1, "nginx publishes exactly one port");
  assert.match(published[0], /^443:443$/, "the single published host port is 443 to container 443");
});

test("every service lives on the internal bridge network, which stays egress-capable", () => {
  for (const name of Object.keys(services)) {
    assert.deepEqual(
      services[name].networks,
      ["internal"],
      `${name} must attach only to the internal network`
    );
  }
  // Not a Docker `internal: true` network: the Go server needs outbound
  // provider access in later slices (Kapon), which such a network blocks.
  assert.equal(compose.networks.internal.driver, "bridge");
  assert.notEqual(compose.networks.internal.internal, true);
});

test("upstream and build-base images are pinned by digest", () => {
  const digest = /@sha256:[0-9a-f]{64}/;
  for (const name of ["postgres", "nginx"]) {
    assert.match(
      services[name].image,
      digest,
      `${name} image must be digest-pinned`
    );
  }
  for (const dockerfile of [
    readDeploy("Dockerfile.server"),
    readDeploy(join("cert-init", "Dockerfile")),
  ]) {
    const fromLines = dockerfile
      .split("\n")
      .filter((line) => /^\s*FROM\s+\S+/i.test(line));
    assert.ok(fromLines.length > 0, "dockerfile has FROM stages");
    for (const line of fromLines) {
      assert.match(line, digest, `FROM must be digest-pinned: ${line.trim()}`);
    }
  }
});

test("public baseline forces the setup code with an explicit opt-out only", () => {
  assert.match(
    services.server.environment.NEVIX_SETUP_CODE_REQUIRED,
    /^\$\{NEVIX_SETUP_CODE_REQUIRED:-true\}$/,
    "compose default must be true; isolated intranet disables it explicitly via .env"
  );
  assert.match(
    envExample,
    /^NEVIX_SETUP_CODE_REQUIRED=true$/m,
    "the copied template must keep claim protection on; opt-out is an explicit manual edit"
  );
});

test("database URLs target the internal network, never loopback", () => {
  for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    const url = services.server.environment[key];
    assert.match(url, /@postgres:5432\//, `${key} must use the internal postgres service`);
    assert.doesNotMatch(url, /(127\.0\.0\.1|localhost)/);
  }
});

test("deploy passwords carry a URL-safe charset contract", () => {
  // The DSNs interpolate passwords as raw URL userinfo, so the template must
  // pin a charset that cannot corrupt URL parsing: reserved characters in a
  // random password would break startup in a way the stack cannot diagnose.
  assert.match(envExample, /charset contract/i, "the template documents the password charset");
  assert.match(envExample, /letters, digits/i, "the charset is pinned to URL-safe characters");
});

test("cert provisioning is required and gates the edge", () => {
  assert.match(
    services["cert-init"].environment.NEVIX_PUBLIC_IP,
    /:\?/,
    "NEVIX_PUBLIC_IP must be a required variable"
  );
  assert.equal(
    services.nginx.depends_on["cert-init"].condition,
    "service_completed_successfully"
  );
  assert.equal(
    services.server.depends_on.postgres.condition,
    "service_healthy"
  );
  assert.deepEqual(services["cert-watch"].volumes, ["tls:/etc/nginx/tls:ro"]);
  const nginxMounts = services.nginx.volumes;
  assert.ok(
    nginxMounts.some((mount) => mount === "./nginx/nginx.conf:/etc/nginx/nginx.conf:ro"),
    "nginx config is mounted read-only from the repo"
  );
  assert.ok(
    nginxMounts.some((mount) => mount === "tls:/etc/nginx/tls:ro"),
    "nginx reads the persisted certificate from the tls volume"
  );
});

test("nginx terminates only TLS 1.2/1.3 on the provisioned pair", () => {
  assert.match(nginxConf, /listen 443 ssl;/);
  assert.match(nginxConf, /listen \[::\]:443 ssl;/);
  assert.match(nginxConf, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3\s*;/);
  assert.match(nginxConf, /ssl_certificate\s+\/etc\/nginx\/tls\/server\.pem;/);
  assert.match(nginxConf, /ssl_certificate_key\s+\/etc\/nginx\/tls\/server\.key;/);
  assert.match(nginxConf, /server_tokens off;/);
});

test("nginx drops client Forwarded headers and writes only the trusted marker", () => {
  assert.match(nginxConf, /proxy_set_header Forwarded "";/);
  assert.match(nginxConf, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginxConf, /proxy_set_header X-Forwarded-Proto https;/);
  // The client-supplied variants are never forwarded: the only occurrences of
  // X-Forwarded-* assignments are the sanitized ones above.
  const forwardedAssignments = nginxConf.match(/proxy_set_header [XF][^;]+;/g) ?? [];
  const forwarded = forwardedAssignments.filter((line) => /Forwarded/i.test(line));
  assert.deepEqual(forwarded.sort(), [
    'proxy_set_header Forwarded "";',
    "proxy_set_header X-Forwarded-For $remote_addr;",
    "proxy_set_header X-Forwarded-Host $host;",
    "proxy_set_header X-Forwarded-Port 443;",
    "proxy_set_header X-Forwarded-Proto https;",
  ]);
});

test("nginx proxies without buffering so SSE, Range, and large files stream", () => {
  assert.match(nginxConf, /proxy_buffering off;/);
  assert.match(nginxConf, /proxy_request_buffering off;/);
  assert.match(nginxConf, /proxy_max_temp_file_size 0;/);
  const bodySize = nginxConf.match(/client_max_body_size\s+(\d+)m;/);
  assert.ok(bodySize, "client_max_body_size is set in MiB");
  assert.ok(
    Number(bodySize[1]) >= 200,
    `client_max_body_size ${bodySize[1]}m must admit 200 MiB video uploads`
  );
});

test("nginx carries security response headers and credential-surface rate limits", () => {
  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
  ]) {
    assert.match(nginxConf, new RegExp(`add_header ${header} `));
  }
  assert.match(nginxConf, /limit_req_zone \$binary_remote_addr zone=nevix_auth:/);
  assert.match(nginxConf, /limit_req_zone \$binary_remote_addr zone=nevix_general:/);
  assert.match(nginxConf, /limit_conn_zone \$binary_remote_addr zone=nevix_conn:/);
  for (const path of [
    "/identity/auth/login",
    "/identity/register",
    "/identity/setup/initialize",
  ]) {
    const location = nginxConf.match(
      new RegExp(`location = ${path.replace(/\//g, "\\/")} \\{([\\s\\S]*?)\\}`)
    );
    assert.ok(location, `credential location for ${path} exists`);
    assert.match(
      location[1],
      /limit_req zone=nevix_auth/,
      `${path} is rate limited`
    );
  }
  assert.match(nginxConf, /limit_req zone=nevix_general/);
  assert.match(nginxConf, /limit_conn nevix_conn \d+;/);
});

test("cert-init mints a five-year IP-SAN certificate with a 0600 key and fingerprint", () => {
  assert.match(certInit, /set -eu/);
  assert.match(certInit, /VALIDITY_DAYS=1826/);
  assert.match(certInit, /-days "\$VALIDITY_DAYS"/);
  assert.match(certInit, /subjectAltName=IP:\$PUBLIC_IP/);
  assert.match(certInit, /umask 077/);
  assert.match(certInit, /chmod 600 "\$KEY_FILE(\.new)?"/);
  assert.match(certInit, /fingerprint -sha256/);
  assert.match(certInit, /-addext "subjectAltName=IP:\$PUBLIC_IP"/);
});

test("cert-init reuses the persisted pair and only rotates explicitly", () => {
  assert.match(certInit, /restarts and upgrades never rotate silently/);
  assert.match(certInit, /CERT_FORCE_NEW/);
  // Reuse is validated, not assumed: parse + key-match + liveness + SAN match.
  assert.match(certInit, /-checkend 0/);
  assert.match(certInit, /-checkip "\$PUBLIC_IP"/);
  assert.match(certInit, /certificate_pubkey_digest/);
  assert.match(certInit, /private_key_pubkey_digest/);
  // An invalid persisted pair fails closed: the only regeneration path once a
  // pair exists is the explicit CERT_FORCE_NEW rotation.
  assert.match(certInit, /refusing to touch the persisted certificate/i);
});

test("certificate expiry alerting stays visible inside the 90-day window", () => {
  assert.match(certInit, /EXPIRY_ALERT_DAYS:-90/);
  assert.match(certInit, /EXPIRY_ALERT_DAYS \* 86400/);
  assert.match(certInit, /CERT_MODE:-init/);
  assert.match(certInit, /CERT_MODE=watch[\s\S]*sleep 86400/);
  assert.equal(
    services["cert-watch"].restart,
    "unless-stopped",
    "the daily watcher stays resident"
  );
});

test("postgres first-boot script provisions identity_app without resetting it", () => {
  assert.match(postgresInit, /set -eu/);
  assert.match(postgresInit, /ON_ERROR_STOP=1/);
  assert.match(
    postgresInit,
    /WHERE NOT EXISTS \(SELECT FROM pg_roles WHERE rolname = 'identity_app'\)/
  );
  // The password travels as a psql variable so quoting cannot break the SQL.
  assert.match(postgresInit, /-v identity_password=/);
  assert.match(postgresInit, /:'identity_password'/);
  // Comment prose may reference the documented ALTER ROLE rotation; active
  // lines must not contain any credential-changing statement.
  const activeLines = postgresInit
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(
    activeLines,
    /ALTER ROLE|DROP ROLE/,
    "credentials rotate via documented ALTER ROLE, never automatically"
  );
});

test("the deploy env template carries every required variable", () => {
  for (const key of [
    "NEVIX_PUBLIC_IP",
    "POSTGRES_PASSWORD",
    "NEVIX_IDENTITY_APP_PASSWORD",
    "NEVIX_SETUP_CODE_REQUIRED",
    "CERT_FORCE_NEW",
  ]) {
    assert.match(envExample, new RegExp(`^${key}=`, "m"), `${key} documented in .env.example`);
  }
});

// ---------------------------------------------------------------------------
// Runtime behavior (Docker-gated)
// ---------------------------------------------------------------------------

const dockerAvailable = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const runtimeEnabled =
  process.env.NEVIX_DEPLOY_RUNTIME_TESTS === "1" || dockerAvailable();
const runtimeOptions = runtimeEnabled ? {} : { skip: "no Docker daemon available" };

test("runtime: docker compose resolves the effective port surface", runtimeOptions, () => {
  const envDir = mkdtempSync(join(tmpdir(), "nevix-deploy-env-"));
  const envFile = join(envDir, "env");
  writeFileSync(
    envFile,
    [
      "NEVIX_PUBLIC_IP=203.0.113.10",
      "POSTGRES_PASSWORD=runtime-postgres-pw",
      "NEVIX_IDENTITY_APP_PASSWORD=runtime-identity-pw",
    ].join("\n")
  );
  const resolved = JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        join(deployDir, "docker-compose.yml"),
        "--env-file",
        envFile,
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8" }
    )
  );
  const resolvedServices = resolved.services ?? {};
  for (const [name, service] of Object.entries(resolvedServices)) {
    if (name === "nginx") continue;
    assert.equal(
      service.ports,
      undefined,
      `resolved config for ${name} publishes no host ports`
    );
  }
  assert.deepEqual(
    (resolvedServices.nginx.ports ?? []).map((port) => `${port.published}:${port.target}`),
    ["443:443"],
    "resolved nginx publishes exactly 443"
  );
  // The public baseline holds through interpolation when the operator did not
  // override it: the setup code stays required.
  assert.equal(
    resolvedServices.server.environment.NEVIX_SETUP_CODE_REQUIRED,
    "true",
    "effective setup-code requirement defaults to true"
  );
  assert.match(resolvedServices.server.environment.DATABASE_URL, /@postgres:5432\//);
});

test("runtime: certificate lifecycle generate → reuse → fail closed → explicit rotation", runtimeOptions, () => {
  const tag = "nevix-cert-init-qa";
  execFileSync("docker", ["build", "-t", tag, join(deployDir, "cert-init")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const volume = "nevix-cert-init-qa-volume";
  const run = (extraEnv) =>
    spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/etc/nginx/tls`,
        ...Object.entries(extraEnv ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        tag,
      ],
      { encoding: "utf8" }
    );

  try {
    execFileSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });

    const first = run({ NEVIX_PUBLIC_IP: "203.0.113.10" });
    assert.equal(first.status, 0, `first provisioning succeeds:\n${first.stderr}`);
    const firstFingerprint = first.stdout.match(/fingerprint: ([0-9A-F:]+)/)?.[1];
    assert.ok(firstFingerprint, "first run prints the SHA-256 fingerprint");

    const reuse = run({ NEVIX_PUBLIC_IP: "203.0.113.10" });
    assert.equal(reuse.status, 0, `reuse run succeeds:\n${reuse.stderr}`);
    assert.match(reuse.stdout, /reusing persisted certificate/);
    assert.equal(
      reuse.stdout.match(/fingerprint: ([0-9A-F:]+)/)?.[1],
      firstFingerprint,
      "restart reuses the persisted pair without rotation"
    );

    const ipChange = run({ NEVIX_PUBLIC_IP: "198.51.100.7" });
    assert.notEqual(ipChange.status, 0, "a public-IP change fails closed");
    assert.match(
      ipChange.stderr,
      /CERT_FORCE_NEW/,
      "the failure points at the explicit rotation command"
    );

    // Corrupt the persisted pair: provisioning must refuse, not regenerate.
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/etc/nginx/tls`,
        "--entrypoint",
        "sh",
        tag,
        "-c",
        "echo broken > /etc/nginx/tls/server.pem",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const corrupt = run({ NEVIX_PUBLIC_IP: "203.0.113.10" });
    assert.notEqual(corrupt.status, 0, "a corrupt persisted certificate fails closed");
    assert.match(corrupt.stderr, /CERT_FORCE_NEW/);

    // An incomplete pair (either half deleted) is damage, not emptiness: both
    // halves missing must be required before first provisioning regenerates.
    for (const half of ["server.pem", "server.key"]) {
      const restored = run({ NEVIX_PUBLIC_IP: "203.0.113.10", CERT_FORCE_NEW: "true" });
      assert.equal(restored.status, 0, `restore a valid pair before the ${half} check`);
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${volume}:/etc/nginx/tls`,
          "--entrypoint",
          "sh",
          tag,
          "-c",
          `rm /etc/nginx/tls/${half}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const incomplete = run({ NEVIX_PUBLIC_IP: "203.0.113.10" });
      assert.notEqual(
        incomplete.status,
        0,
        `a persisted pair missing only ${half} fails closed`
      );
      assert.match(incomplete.stderr, /incomplete/);
    }

    const rotated = run({ NEVIX_PUBLIC_IP: "203.0.113.10", CERT_FORCE_NEW: "true" });
    assert.equal(rotated.status, 0, `explicit rotation succeeds:\n${rotated.stderr}`);
    const rotatedFingerprint = rotated.stdout.match(/fingerprint: ([0-9A-F:]+)/)?.[1];
    assert.ok(rotatedFingerprint);
    assert.notEqual(
      rotatedFingerprint,
      firstFingerprint,
      "explicit rotation mints a new identity"
    );
  } finally {
    spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
  }
});
