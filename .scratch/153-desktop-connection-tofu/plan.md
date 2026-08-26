# #153 — 收紧 Desktop 客户连接与 TOFU 生命周期

Spec source: #150 (AI Creation V1) · Ticket: #153 · Blocked-by #152 closed ✅
Primary Domain: **Desktop Connection** (`apps/desktop/src/main/connection/`,
`apps/desktop/src/renderer/src/features/connection/`, `apps/desktop/src/shared/ipc/connection/`,
`apps/desktop/src/shared/config/server-url.ts`).

High-risk class: **security boundary** (TLS trust + TOFU pin lifecycle) — this plan is
required before implementation per root AGENTS.md.

## Fixed point / boundary

- Fixed point: `main` @ 1713e05. Task branch: `task/153-desktop-connection-tofu`.
- Acceptance boundary: the 8 acceptance criteria of #153 (QA-checked item by item
  on the issue before close).
- Current baseline: TOFU runtime landed with #104 (PR #115); RFC1918 plain http is
  still a customer exception, `/health` identity is unchecked, expiry is reported as
  generic unreachable, and the Electron pin override can trust an expired certificate.

## Design decisions

1. **URL policy (AC1).** `parseServerUrl` stays the structural origin parse
   (https or http scheme, exact origin, no credentials/path/query/hash). The
   destination policy becomes: **https anywhere; plain http only for loopback
   hostnames on an unpackaged (development) runtime** (`!app.isPackaged`).
   RFC1918 http is rejected in every mode. Enforcement is main-process-only
   (`probeServerConnection`, `saveServerConnectionUrl`, `loadIntoRuntime`
   re-validation) so the renderer never needs to know the runtime mode; the
   renderer keeps structural pre-validation for immediate malformed-URL feedback
   and defers the http-destination verdict to the authoritative probe result.
2. **Probe verdicts (AC2/6/7).** `/health` must answer `200` with
   `{"status":"ok","service":"nevix-server"}`; anything else reachable-but-wrong
   is the new `incompatible-server` outcome (server composition root adds the
   `service` field — additive, no OpenAPI surface). `CERT_HAS_EXPIRED` (and an
   expiry check inside the TOFU branch, because OpenSSL may surface the
   self-signed code first) maps to the new `certificate-expired` outcome with
   the certificate view. Standard verification and one-shot connections
   (`keepAlive:false`, `Connection: close`) are unchanged.
3. **Shared TOFU verdict (AC5/7).** One pure decision, `isTrustworthyPin` in
   `certificate-pins.ts`: pin exists ∧ fingerprint equals pin ∧ validity known
   ∧ not expired. The Node probe and the Electron `setCertificateVerifyProc`
   both use it, so pinning can never override expiry and both halves of the
   runtime answer identically. Fail closed on unknown validity.
4. **Near-expiry feedback (AC7).** A reachable https probe reports the observed
   certificate's `validTo`; the editor shows a stable warning
   (`certificate-near-expiry`) when expiry is within 90 days — the same boundary
   the deployment's cert-init alert uses (`EXPIRY_ALERT_DAYS`), one number
   across the product.
5. **Renderer states (AC6).** New editor failure values `incompatible-server`
   and `certificate-expired` (distinct copy, never phrased as an authentication
   failure). Startup states already cover first load (`restoring → Connection
Screen`), network interruption / recovery (`restore-failure` retry re-runs
   the authoritative restore), and session invalidation (`session-rejected` →
   clear + notice); this slice keeps those and adds the missing
   server-incompatible and certificate-expiry states.
6. **No new Main/IPC owner (AC8).** All changes stay inside the existing
   `connection` Domain seams; `ServerConnectionProbe` is extended in place; no
   new channel, no Electron Main/preload creation code.

## Task-owned paths

- Shared/main: `apps/desktop/src/shared/config/server-url.ts`,
  `apps/desktop/src/shared/ipc/connection/types.ts`,
  `apps/desktop/src/main/connection/{probe,certificate-pins,certificate-verify,connection-store}.ts`
- Renderer: `apps/desktop/src/renderer/src/features/connection/model/use-server-connection-editor.ts`,
  `.../ui/server-connection-editor-fields.tsx`, `.../i18n/resources.ts`
- Server (supporting, composition root only): `server/cmd/server/main.go`,
  `deploy/README.md`
- Tests: `apps/desktop/tests/unit/{server-url,connection-runtime}.test.mts`,
  new `apps/desktop/tests/component/connection-screen.spec.tsx` (+ story fixture),
  `apps/desktop/tests/connection/{connection-screen,connection-expiry,connection-tofu}.spec.ts`,
  `apps/desktop/scripts/run-e2e.sh`

## Verification plan (TDD where seams allow)

- Unit first (red→green): URL policy matrix, `isTrustworthyPin` matrix, pin
  sanitization/CSP regressions.
- Component (public surface): Connection Screen with scripted `window.api` —
  standard-cert reachable (no decision UI), self-signed first connect, refused
  confirmation (save never invoked), persisted pin, fingerprint change, dev
  loopback accepted, customer http rejected, incompatible server, expired
  certificate, near-expiry warning.
- Electron E2E (real TLS): existing TOFU/rotation specs stay green; new
  expired-certificate rotation spec (recovery included), incompatible-server
  spec (plain non-Nevix loopback server), RFC1918 http rejection; near-expiry
  asserted against the 2-day harness certificate.
- Full gates before review: `pnpm typecheck`, `test:unit`, `test:component`,
  connection E2E suite, `go build ./...` + server tests for the health change.

## Rollback

One PR, one squash commit; revert restores the #104 baseline. The persisted
connection store shape is unchanged (no migration); a previously persisted
RFC1918 http URL simply re-enters the Connection Screen after the tightening —
clean-start V1, no compatibility window needed (spec #150 Migration decision).
