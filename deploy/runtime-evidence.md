# Offline runtime evidence

Acceptance entrypoint: `deploy/scripts/test-offline-runtime.sh`. It builds the four real
linux/amd64 images from a committed export, then exercises the operator with generated
**test-only** signing material on a fresh isolated Linux Docker daemon. No test key is
compiled into the shipped operator or accepted by its production CLI.

Required native acceptance: Linux amd64 Docker Engine API >= 1.49 (floor 28.2),
Compose >= 2.38.0; classic image store and containerd image store must each pass before
claiming both supported. CLI capabilities are checked before runtime mutation.

Current local host is Darwin arm64 / OrbStack Linux arm64, Engine 29.4.0 / Compose
5.1.2. Archive verification and real image export can be tested there; it is **not**
native Linux x64 first-install evidence. Native acceptance is enforced by the Ubuntu
CI runtime job; record its actual Engine/Compose versions and result here or in the
release acceptance record before a production release. Until then, runtime acceptance
remains pending. No customer deployment or production signing was performed.

Local real package proof (2026-10-09): source `e13b491f55098b205c12a44beb621cd040996b2a`,
version `1.2.345`, minimum Desktop/source Server `1.0.0`. The tracked-input builder
produced `/tmp/nevix-345-real-bundle.tar.gz` (141,936,859 bytes), exactly eight closed
outer entries, four actual linux/amd64 runtime images, and the cross-compiled Linux
amd64 operator. `NEVIX_DEPLOY_VERIFY_BUNDLE=/tmp/nevix-345-real-bundle.tar.gz go test
./internal/deployment -run '^TestBuiltRealBundleVerifies$' -count=1 -v` passed: a fresh
in-memory test Ed25519 signature authenticated the exact real archive, and the same
operator verify path checked the inventory, config/manifest digests, platform and all
blob bytes. Production CLI still refuses test keys. This proves build/export/trust,
not import/start on native Linux. Docker 29 save retained upstream SBOM/provenance
referrers despite platform filtering; the validator accepts only unknown/unknown
non-runnable in-toto referrers bound to one of the four runnable platform manifests.
