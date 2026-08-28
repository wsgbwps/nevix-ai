# #158 code-review ledger

Two-axis review (Standards + Spec) over `main...feat/158-capability-manifest`,
aggregated 2026-08-28. Dispositions below; fixes landed in the follow-up
commit on the task branch.

## Standards axis (no hard violations; judgement calls)

| Finding | Disposition |
| --- | --- |
| P3 `manifest.go` activation comment claimed "default unpassed ⇒ media deactivated" while the code (per plan) falls back to the first passed value | **Fixed** — comment rewritten to the fallback semantics; `TestDeriveManifestDefaultsFallBackWhenSpecDefaultUnpassed` now uses an available connection and asserts default=480p through the real fallback path |
| P3 checklist `dimension` strings and `manifestDimensions` could drift: a new checklist dimension would gate nothing and no test would fail | **Fixed** — `TestManifestDimensionsCoverEveryChecklistDimension` locks every checklist dimension into its media's activation gate |
| P3 `ReadinessChecklistSchemaVersion` gated two documents (checklist + evidence) under one exported name; `ReadinessChecklist`/`ReadinessSlotForValue` exported without external consumers | **Fixed** — renamed to unexported `readinessSchemaVersion` (documented as the readiness document family version) and unexported the two helpers |
| P3 manual workflow interpolated `${{ inputs.slots }}` into the shell of a runner holding `KAPON_API_KEY` | **Fixed** — inputs pass through `env` and each slot id is validated against `[A-Za-z0-9._-]` before use |
| P3 `readString/readNumber` duplicated from `provider-connection-http.ts` | Kept — same deliberate duplication precedent as #157's error-envelope writer; a shared api parsing module is not warranted by two consumers with diverging shapes |
| P3 `pickDefault`/`pickDefaultInt` near-duplicate; media discriminator repeated across helpers | Kept — passed-value maps are string-keyed by checklist slot values; the int variants are thin wrappers. The manifest content tables are the shared shape |

## Spec axis (all 8 acceptance criteria implemented)

| Finding | Disposition |
| --- | --- |
| P3 Desktop client dropped the published `prompt` and `per_media` reference envelopes — the Workbench could not mirror the full allowed-value contract | **Fixed** — client parses and exposes `prompt` plus per-media image/video/audio envelopes on every mode; malformed optional lists (`ratios`/`quantities`/`durations`) and envelopes now fail closed instead of silently shrinking the capability set (absent vs malformed distinguished) |
| P3 prompt-length parameter has no checklist slot | Accepted — prompt 1–2000 is a static contract envelope (like output PNG), not a provider capability value; it is exercised by every generation probe's real submission. Slot gating is reserved for capability values whose availability can change |
| P3 AC5 "超时" has no explicit timeout simulation (transport-failure unit test drives the same mapping path) | Accepted — the kapon client maps transport errors and timeouts to the same transient verdict; covered by `models_test.go` + integration transient scenarios |
| First harness run failed `TestCapabilityManifestActivatesWithEvidenceAndConnection` conformance | **Fixed during development** — the contract had declared `reason`/`action` required while available media omit them (omitempty); the contract now marks only `available` required, matching the wire. The conformance sentinel caught exactly the drift it exists for |
