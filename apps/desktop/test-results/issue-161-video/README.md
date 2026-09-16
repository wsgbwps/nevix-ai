# #161 Video-generation visual QA

This directory holds the small, reviewable visual evidence for the local
`codex/161-video-generation` candidate. It is not a build-output directory.

## Fixed prototype baseline

The baseline comes from pinned prototype commit
[`6e465e8`](https://github.com/wsgbwps/nevix-ai/commit/6e465e8d1f865d6c0e21b0e14b2e69bbab9e776a),
served from a disposable detached checkout.

- `baseline-frames-960.png` — 960x600, video first/last-frame composer.
- `baseline-omni-1280.png` — 1280x800, video omni-reference composer.

The pinned prototype is explicitly throwaway UI. Its dark palette, fixture
Seedance 2.0 model and fixed `4:5`/`720p`/`1`/`5s` values are not production
parameter authority.

## Current candidate

- `current-frames-{960,1280}.png` — first/last-frame deck and rail.
- `current-duration-960.png` — upward duration menu, slider and select.
- `current-params-960.png` — upward ratio/resolution/quantity menu.

The candidate deliberately keeps the current production Workbench's light
theme, as requested. The comparison verifies the accepted interaction
hierarchy: a compact bottom rail; media, model, mode, parameters and duration
in that order; inline reference cards; and upward parameter menus. The model,
ratio, resolution, quantity and duration values in the candidate are supplied
only by the current capability manifest and remain server-validated.

This delivery ends at a local commit. A PR will link this evidence and the
full QA report only after the user authorizes pushing the branch.
