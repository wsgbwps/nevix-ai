# Nevix stable release v1

ADR-0026 / #341. `nevix-release-v1` means Nevix product / Desktop App ID `com.nevix.ai`; other products cannot reuse this format. Support: Desktop win32/x64 NSIS `.exe`, darwin/arm64 update `.zip` (DMG first install); Server linux/amd64 full `.tar.gz` bundle. Main uses actual `process.platform` and `process.arch`, never inferred OS labels.

Envelope has exactly `format`, `payload`, `signature`, in that order; compact JSON only (optional surrounding whitespace). `payload` is canonical padded base64 of exact UTF-8 compact JSON, signed directly with Ed25519 (no prehash); `signature` is canonical padded base64 of 64 bytes. Payload **field order** is exactly:

`version,channel,platform,arch,min_server_version,min_desktop_version,url,size,sha512`

All nine fields required, no extra/duplicate fields, whitespace, BOM or alternative escaping. Canonical bytes equal JavaScript `JSON.stringify` of those fields in that order; text is ASCII (URL uses percent encoding). String fields cannot use escaped characters. `channel` is `stable`. Version strings are exactly `major.minor.patch`, unsigned components <= 2147483647, no leading zeros/pre-release/build. `size` is a positive safe JSON integer <= 9007199254740991. `sha512` is padded base64 of 64 digest bytes. URL must be absolute HTTPS, one nonempty authority immediately after `https://`, no userinfo or percent-encoded authority/zones, well-formed `%HH` escapes, no fragment, and must name the target's file suffix. darwin/arm64 may sign `.zip` or `.dmg` as separate envelopes; Main exclusively accepts ZIP for update. No runtime public key from the envelope/source is trusted. Node uses crypto, Go uses crypto/ed25519 + x509 only.

Official anonymous manifest endpoints:

- `https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/win32-x64.json`
- `https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/darwin-arm64.json`
- `https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/linux-amd64.json`

Manifest reads use system HTTPS trust, independent of customer TOFU, bounded 64 KiB and request deadlines; redirects are refused for manifest reads. Signed artifact URL can redirect only under the download gate (#342/#346); never downgrade HTTPS. Manifest freshness is candidate version > installed/running version; no candidate is treated as already trusted cached state.

`GET /release/version` is an anonymous Go-owned public endpoint, returning exactly `{service:"nevix-server",version,min_desktop_version}`; no customer data. `release.Version` and `release.MinDesktopVersion` are compiled build identity (`-ldflags -X github.com/nevix-ai/server/internal/release.Version=... -X github.com/nevix-ai/server/internal/release.MinDesktopVersion=...`), never customer environment values. Development version is `development`, deliberately unknown for update compatibility. Release builds must set both stable versions and match their signed release.

For a Desktop candidate: runtime Server version >= candidate.min_server_version AND candidate.version >= runtime Server.min_desktop_version. Independently, installed Desktop < runtime minimum produces a clear prompt. Unknown/malformed/unreachable Server defers update; never infer compatibility from `/health` or local constants. For a Server bundle: payload.version is target Server version, min_desktop_version is its declared minimum Desktop, min_server_version is the oldest supported source Server for this upgrade. Runtime endpoint must agree with the installed release. All targets sign both compatibility fields; candidate Desktop min_desktop_version is descriptive paired-server policy, not a substitute for the actual runtime endpoint.

Release gate: production Ed25519 public anchor is intentionally unset until vendor provisioning. Clients fail visibly closed; no experiment key or runtime environment/source key fallback. Reviewed public anchor must be compiled into Desktop, Go and tool with identical fingerprint before formal release. Private keys never enter these artifacts. Stable Mac signing identity and offline key backup also remain release inputs.

First-install DMG is signed independently at `stable/darwin-arm64-dmg.json`; `stable/darwin-arm64.json` remains ZIP-only. Both envelopes bind each file’s exact URL, size and digest; changing artifact without changing signature fails. Go tooling accepts either darwin extension for publication verification.

Official `deploy/Dockerfile.server` accepts `RELEASE_VERSION` and `MIN_DESKTOP_VERSION` build args (current baseline defaults 0.1.0); formal packaging must pass the signed release values explicitly. Server validates compiled identity before opening its database. Source development builds remain unknown.

Admin presentation: `GET /release/status` reads the last check; `POST /release/check` performs a bounded anonymous fixed-source check and returns the visible result. Both use Identity's active Admin guard; Members, invalid and revoked sessions cannot read or check. The Go Release Module checks on startup and every 24 hours. Failed checks clear the candidate and stay silent in the background without changing business admission, containers or database state. Status includes the real current version/minimum Desktop and, only for a verified newer candidate, its version/minimum source Server/minimum Desktop and source compatibility. Empty compiled anchor, unknown build identity, invalid signature/format, unavailable source, already-current and incompatible candidates are explicit outcomes. See [release API](release.yaml). Desktop renders this status in the existing Admin Settings flow; it grants no remote upgrade action.
