# Exact signed Linux offline runtime acceptance

`test-final-offline-runtime.sh` is a vendor acceptance driver for two **already built, production signed** Linux/amd64 bundles. It does not build, repack, sign, alter a trust anchor, download images or use the tool inside a candidate bundle. It is separate from `test-offline-runtime.sh`, whose generated fixture releases are regression evidence rather than final release bytes.

Run on native Linux x86_64 with Python 3, GNU coreutils, iproute2, util-linux (`unshare`, `nsenter`, `setpriv`), passwordless sudo for the isolated fixture, containerd, Docker Engine >= 28.2/API >= 1.49 and Docker Compose >= 2.38.0. The Docker socket, image cache, volumes, network namespace, daemon config and credentials belong to a fresh private temporary directory. The namespace has only loopback and its container bridge, with no outgoing route. The fixture cannot access a registry. The host Docker daemon is never selected. Run both `classic` and `containerd` storage modes separately if both are required by the release gate.

Before running, obtain an **independently trusted** native `nevix-deploy` executable with the production compiled public anchor, and its SHA-256 through the reviewed vendor build/handoff. Also obtain the old and candidate full runtime bundles and their genuine production signed Linux envelopes. An unsigned old release or an unconfigured/experimental CLI is a blocking prerequisite; do not manufacture a substitute signature. Each source SHA must be the full 40-character commit from the corresponding reviewed tag/build receipt. The signed bundle's `bundle.json.source_commit` must match it. Keep `v1.0.0` rejected and unpublished; the current candidate is `v1.0.1`.

Example (replace all paths, hash and source values with actual reviewed inputs):

```bash
NEVIX_DEPLOY_TEST_STORE=containerd \
  deploy/scripts/test-final-offline-runtime.sh \
  /trusted/nevix-deploy "$TRUSTED_CLI_SHA256" \
  /releases/old-runtime.tar.gz /releases/old-linux-amd64.json 0.1.0 "$OLD_SOURCE_SHA" \
  /releases/nevix-runtime-1.0.1-linux-amd64.tar.gz /releases/linux-amd64.json 1.0.1 "$FINAL_SOURCE_SHA" \
  /evidence/linux-amd64-containerd.json
```

The receipt must be a new file in an existing directory. The driver freezes all four artifact/envelope inputs and the trusted verifier in its private fixture before verification. It checks the supplied CLI SHA-256 and invokes the unchanged CLI's compiled-anchor `verify` on both pairs before creating the daemon. It then checks actual SHA-512, size, Linux/amd64 identity, version and authenticated inventory source SHA. It calls the official `import`, `install` and `upgrade` commands. Credentials and command logs remain private and are deleted with the fixture; response bodies are not printed.

Covered assertions are empty-cache installation of the old exact bundle, public HTTPS first Admin claim, real login and identity retention, restart persistence, unchanged customer `.env` and TLS, preservation of the three persistent volumes and original PostgreSQL container, Server replacement and resumed admission. The unchanged production upgrade command supplies its normal pause/drain, recoverable backup, isolated restore rehearsal, retained-history/config/private-volume checks and candidate health/release gates. A separate negative test exclusively creates an owned unexpected marker in the existing fixture secrets volume. The real backup must reject extra material before replacement, resume admission and retain the old Server. The marker is removed in `finally`, and the original secrets inventory must match before the positive upgrade and afterward. This works when the lazily created credential master key is legitimately absent after claim/login; no key is fabricated, rewritten or chmodded.

The sanitized receipt records only CLI SHA-256, old/new Linux artifact SHA-512 and size, authenticated source/version identities, native platform, storage mode, completed assertions and missing cases. `passed-covered-cases` means those assertions passed; it does **not** mean all of #349 is accepted. Queued-task drain timeout/fencing, deliberate candidate migration failure, deliberate candidate health failure, Desktop/Server version-window refusal and configured encrypted provider/object-storage credential retention remain explicitly missing. The final candidate is not mutated or re-signed to create fault releases. No mainland carrier, real public-host download, Desktop update or compiled-source bridge acceptance is implied.

A failure during fixture execution writes `status: failed` plus a fixed failed-step label and exits nonzero. A failed prerequisite or signature verification exits nonzero before runtime work and produces no success receipt. Native platform absence is a hard failure; there is no emulation acceptance mode. This driver has only received syntax, metadata and refusal-marker preservation self-checks until an actual receipt from a run with genuine inputs is available.

Checks that do not start an app, Docker daemon, signing tool or runtime:

```bash
bash -n deploy/scripts/test-final-offline-runtime.sh
bash deploy/scripts/test-final-offline-runtime.sh --self-check
```

The self-check tests metadata/source mismatch and changed-byte refusal with temporary unsigned metadata fixtures, plus the exact exclusive marker injector on temporary absent-key and dummy-key directories. It proves preexisting markers are not overwritten and original key bytes/permissions are preserved. It exercises no signature verifier and makes no production acceptance claim.
