# #161 Video generation QA

## Verdict

**Local implementation verified: 11 acceptance items accepted; PR-link clause
pending at the repository-mandated handoff.** The local candidate passes the
implemented-product checks with no surviving Standards or Spec findings. The
required comparison was completed locally and its screenshots are committed
here, but no PR exists yet: repository delivery policy requires an explicit
post-verification push/PR instruction. Real Kapon credential smoke remains a
release gate and was not run; recorded/fake adapter conformance covers the
implementation contract without a billable request.

Branch: `codex/161-video-generation`. Review baseline:
`1f9ae7bfbc8908c232c3bc5fae52f7dfdc5a2b42`.

## Acceptance matrix

| # | Acceptance | Evidence | Result |
| --- | --- | --- | --- |
| 1 | Frames/omni UI and 0/1/2 frame normalization | Final component 24/24; Module frame-role tests | PASS |
| 2 | Prompt bounds and manifest-owned reference ceilings | Video admission and retry Module tests | PASS |
| 3 | Image/video/audio MIME, bytes and duration envelopes | Component MIME/alias and invalid-envelope cases; Module admission tests | PASS |
| 4 | 480p/720p/1080p, 720p default, manifest durations and stale blocking | Component manifest/default/stale and parameter checks | PASS |
| 5 | Seedance 2.5 native submit/poll/DELETE and provider deadline | Kapon adapter package tests and recorded native payload assertions | PASS |
| 6 | Best-effort cancel, races, indeterminate and restart convergence | Task lifecycle/cancel/restart Module tests | PASS |
| 7 | MP4 stream, MIME/checksum/dimensions/duration/size/audio and single Range | Result Range/checksum/audio Module tests; video Electron download | PASS |
| 8 | Existing Task interface handles partial/retry/indeterminate | Task lifecycle, partial-success and historical-retry tests | PASS |
| 9 | Small-window keyboard UI, mixed deck, results/play/download | 960x600/1280x800 component checks and video Electron tracer | PASS |
| 10 | Adapter/Module/input/Range/cancel/Desktop/Electron checks | Focused package + Module checks, full component and Electron receipts | PASS |
| 11 | Explicit non-goals absent | Diff-scope review; no multi-frame intelligence, lip sync, imitation, continuation, standalone audio asset, editor or timeline | PASS |
| 12 | Pinned prototype comparison at 960x600 and 1280x800; PR links it | Local comparison in `README.md` and baseline/current screenshots | Local PASS; PR-link pending |

## Final checks

- `pnpm exec playwright test --config playwright-ct.config.ts tests/component/creation-video.spec.tsx` — **24/24 PASS**. Covers public audio aliases, stale ratio, frame normalization, desktop keyboard controls and both required viewport sizes.
- `go test ./internal/creation/infrastructure/kapon ./internal/creation/infrastructure/media ./internal/creation/interface/http` — **PASS**.
- Isolated Module contract: video admission/lifecycle/restart/cancel/Range/checksum/audio selection — **12 PASS, 54.599s**.
- Isolated historical retry: stale unsupported duration rejects; still-supported historical intent/replay remains valid — **2 PASS, 4.096s**.
- Complete Desktop component suite — **222/222 PASS**.
- Complete Electron suite — **77 PASS, 2 platform skips**, plus Creation tail **3/3 PASS** including audio-bearing video; final targeted video Electron path **1/1 PASS**.
- Full unit suite — **407/407 PASS**. Full `go test ./...` — **PASS**; its normal database opt-out scope is distinct from the final official Creation integration run on a real disposable database and object-store stack.
- Desktop node/web typecheck, touched lint and architecture checks — **PASS**.
- Complete official Creation integration — **257/257 PASS, zero skips**
  (`make test-creation-integration`, integration package 530.418s) on the
  final candidate.

## Prototype comparison

The fixed reference is
[`6e465e8`](https://github.com/wsgbwps/nevix-ai/commit/6e465e8d1f865d6c0e21b0e14b2e69bbab9e776a).
The candidate retains the compact composer rail, inline reference deck,
first/last and omni choices, control ordering, upward menus and result flow.

Intentional differences are data-contract and current-style requirements:
production uses Seedance 2.5 instead of prototype Seedance 2.0; native/adaptive
ratios instead of the fixture `4:5`; manifest quantity `1` instead of fixture
`1–4`; and manifest durations `5/10` through an indexed slider plus select
instead of throwaway `1–15`. The production Workbench retains its current
theme; the prototype's dark palette is not copied.

## Shared-area impact

`contracts/creation.yaml` adds video manifest ratio/quantity and result-file
200/206/416 Range headers. Public Module HTTP tests guard that contract. No
shared renderer `lib`, `hooks`, or UI owner changes, and no new trusted seam.

## Review results

### Standards

Initial findings: **2 P2**. Both were fixed and final targeted re-review found
**0 remaining findings** (confidence 0.98).

### Spec

Initial findings: **1 P2**. The historical retry behavior was corrected and
re-reviewed with **0 remaining findings**.

## Regression history and release gate

An earlier complete candidate Creation run had five failures. Five isolated
new-database race rechecks passed, and a complete fixed-main baseline passed
**245 tests with zero skips**. The final candidate's complete official Creation
suite was rerun after the retry and MIME-alias fixes and passed **257/257 with
zero skips**. The earlier failure is retained as history, not presented as a
final-green result.

No real Kapon credential, entitlement, quota or paid media generation call was
made. Those facts remain the #150 production release gate.
