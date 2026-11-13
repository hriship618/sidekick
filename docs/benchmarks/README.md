# Rove local benchmark report

Measured on Windows 10.0.26300, AMD Ryzen AI 7 350 (16 logical processors), Node v24.22.1. Development build on top of commit `fde570e`, with the executable-graph and metrics integration pending commit. This is a local sequential run under the current desktop load, not a controlled hardware lab or installed-app measurement.

Reproduce from the app directory with `pnpm benchmark`. The harness builds the app, creates a disposable profile and SQLite database, opens/closes only its own fixture windows, and removes its temporary directory. It does not use user credentials, change volume, close other apps, or spend provider credits. Raw samples and the labeled query set are in [latest.json](latest.json). Rerunning replaces that JSON; the numbers below describe the recorded run for this report.

| Measurement | Samples | Median | p95 |
| --- | ---: | ---: | ---: |
| Local matcher, warm per-query batch average | 100 batches × 50 queries | 0.00683 ms | 0.01721 ms |
| Static prompt validation + dynamic input construction | 1,000 | 0.1858 ms | 0.3061 ms |
| Compress 407,779 characters and retain full SQLite evidence | 30 | 1.691 ms | 11.249 ms |
| Windows lookup with a new PowerShell helper per request | 5 | 475.071 ms | 508.129 ms |
| Identical lookup with the warm persistent helper | 20 | 68.287 ms | 74.659 ms |
| Launcher renderer IPC → verified close, warm | 20 | 140.642 ms | 160.645 ms |

The launcher became input-ready in 663 ms in one observed startup. Its first close took 385 ms, followed by the 20 warm closes above. All 21 disposable windows were verified closed; each run persisted two steps. The disposable profile had no model connection, so these local closes made zero provider calls. Fixture creation, typing, global-hotkey delivery and app-specific save dialogs are excluded. The helper comparison uses the same read-only query in both paths; its median improvement is 6.96×. The five-sample one-shot p95 is effectively the maximum, so do not treat it as a stable tail estimate. The router p95 is over per-batch averages, not individual-query tail latency.

## Routing accuracy and discovered defect

The hand-labeled set contains 25 simple-intent requests and 25 negative/complex requests. The initial run incorrectly admitted `close Firefox tomorrow` and `close Notepad in 10 minutes` into the immediate-close graph. Corpus queries were only classified, never executed. [before-timing-guard.json](before-timing-guard.json) preserves that run.

A conservative timing guard now sends those requests to the general path, with regression coverage for those and additional scheduling phrases. The rerun accepted 20 requests correctly, admitted zero negative requests, and missed five simple phrasings: `turn up the volume`, `make the sound louder`, `open my Downloads folder`, `exit Notepad`, and `bring up C:\Temp`. These fall back to the general model path rather than executing an inferred local command. Precision among admitted requests was 20/20 and simple-intent coverage was 20/25 (80%) **on this small set**. The rerun includes cases used to fix the guard; it is a regression result, not held-out evaluation. It does not establish calibrated 99% confidence or general real-world accuracy.

## Context efficiency

A synthetic listing of 10,000 file paths shrank from 407,779 characters to 500 model-visible characters: 99.877% fewer characters for that output block. Every sample recovered the exact original text from local SQLite evidence. This excludes later evidence retrieval, the static prompt, other observations and model reasoning. It is not a measured whole-task token saving or a demonstration of unchanged task success under lossy compression.

The captured real tool profile contains 19 definitions: 18,988 schema characters plus 4,138 instruction characters. The prompt manager retained a stable static signature across 1,000 different dynamic requests. Local prompt construction is cheap, but sending this whole catalog could be costly on a cold provider cache. Whether stable full tools beat smaller task-specific profiles needs a live matched comparison.

## What remains unmeasured

- Actual input/output/cached token counts, provider TTFT, API latency and billed cost. No live requests were made.
- Browser workflow success and token usage with and without compression, including evidence retrieval costs.
- Real user tasks and phrasing on a held-out set, wrong-route costs, and clarification rates.
- Hardware volume read-back, hotkey response, packaged startup and installation.

Recommended next experiment: run matched read-only browser tasks against the same page states with compression on/off, recording verified success, total provider tokens including retrieval, cache hits and wall time. Separately compare fixed tool catalogs with stable task-specific catalogs under cold and warm provider conditions. Avoid synthetic delay as a substitute for actual cloud measurements.

After the timing-guard fix, `pnpm check` passed all 42 tests, TypeScript checking, and the production build.
