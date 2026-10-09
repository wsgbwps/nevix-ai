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
