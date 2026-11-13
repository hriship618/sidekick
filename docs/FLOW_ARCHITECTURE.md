# Local routing, stable prompts, and compact trajectories

These modules extend the existing Windows Electron main process. No Python service, model download, graph database, or inference server is required.

Research sources and the boundaries of each adaptation are documented in [RESEARCH.md](RESEARCH.md).

## Executable graphs in the app

`src/execution-graph.ts` is the shared dependency interpreter for saved launcher routines, existing batches, and the model's `execute_graph` tool. It checks the full graph before dispatch, orders prerequisites, executes validated actions sequentially, persists checkpoints, and blocks the remaining plan on failure. Browser nodes with dependents require expected-state checks. Completed nodes are returned explicitly, not silently replayed. Unknown targets are inspected and essential questions answered before compiling known actions into a graph. Tool verification remains authoritative: dispatching a URL or SSH launch does not establish page load or remote login.

Execution details now displays recorded model calls, graph counts, provider-reported token/cache usage, and observation character reduction. Character reduction is not a claim about billed token savings. Automatic induction of new workflows remains planned.

## 1. Local graph router

`src/local-router.ts` defines a directed prerequisite graph and a dependency-order traversal that rejects unknown prerequisites and cycles. Parameter nodes feed `Close-App`, `Open-Dir`, and `Volume-Up`. TF-IDF vectors are built once at module load and rank local intent candidates without network traffic.

Similarity is not calibrated confidence. Automatic execution additionally requires an exact supported command grammar, complete validated parameters, and the existing tool/policy checks. The returned 0.99 admission score means the grammar passed, not a measured 99% probability of correctness. Unknown phrasing and compound/conditional goals go to the existing model path. Do not lower the gate to a raw cosine threshold without measuring false matches on held-out requests.

Examples: `close Notepad`, `shut down Notepad`, `show folder "C:\Users\you\Documents"`, `volume up`, `increase volume by 5 percent`. Amounts are 1–20 percentage points; the default is 5. Only absolute Windows drive paths are accepted. Ambiguous close targets ask a question. Graph parameter prerequisites are checked before dispatch, and runtime window identity is discovered afresh.

Runner dispatches the admitted node into existing execution machinery, persistence and cancellation. The close procedure already performs discovery, selection, graceful close and verification. Directory/file opens retain executable-content policy and accurately report dispatch-only verification. Volume uses the persistent PowerShell worker and Core Audio COM, caps at 100%, and checks the setting after writing it. It does not unmute or claim sound is audible. Desktop commands still honor the Desktop access setting.

OS request arguments travel as validated JSON over stdin, never interpolated user shell text. Worker timeouts and cancellation stop the owned subprocess; a dispatched effect may already have happened. A failed local mutation is reported instead of automatically asking the model to repeat it. Model fallback is appropriate for unmatched/complex requests, not a blind second attempt after an uncertain side effect.

This is a seed graph of hand-authored commands, not an automatically learned workflow system or general A* planner. The versioned learning/promotion design remains in ACTION_GRAPH_PLAN.md.

## 2. Prefix-cache prompt manager

`src/prompt-manager.ts` snapshots instructions and canonical, sorted tool schemas per model session, returns independent schema copies, and rejects mid-session schema/instruction drift. `src/agent.ts` supplies one stable catalog for the run. Browser tools remain gated at execution until browser support is enabled; disabled desktop access cannot be bypassed. Tool schemas are passed through the provider's structured tools field rather than copied a second time into prose.

Goal, constraints, timestamp, answers, recent history and observations stay in the dynamic input suffix. Matching function calls and outputs remain paired. XML-looking page/tool content is explicitly untrusted; XML scratchpads or verbose reasoning output are not required.

The standard OpenAI Responses adapter sends a deterministic, nonsecret `prompt_cache_key` derived from the static prefix. ChatGPT plan access uses its existing request shape with the same stable prefix, without assuming additional cache-control parameters are supported. The adapter records input, output and reported cached-input tokens in local `provider-usage` trace events when the response includes usage.

OpenAI's [prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) explains exact prefix reuse and model-dependent caching behavior. Prefix stability makes reuse possible; it cannot force cache residency, eligibility, account/provider behavior, or a fixed latency reduction. No filler is added to reach a cache threshold. This application does not own inference GPUs, so GPU-aware L7 routing is outside its deployment model. Live cache hits have not been measured in this change; provider tests use local HTTP fixtures without spending account credits.

## 3. Trajectory reducer

`src/trajectory.ts` exports `TrajectoryCompressor` and shell-data middleware. Strings over the default 500-character limit become a bounded tag with exact character/line counts and verbatim excerpts. Optional literal target matching can preserve an observed matching line, but the reducer never infers file counts or invents a path/success claim.

The Windows helper captures stdout and stderr, preserves exit status and partial output, and reports command failures with structured evidence. The agent stores the full result in local SQLite evidence and reduces model-visible output/stderr independently. Existing typed checks and target IDs remain structured. Oversized aggregate tool results are capped through an evidence reference and bounded excerpt. The action ledger sends the latest six entries, with counts for omitted actions; goal, constraints, answers and current desktop observations remain available. `read_evidence` retrieves omitted content in bounded excerpts.

Full traces and evidence are separate from compact model context. Evidence is scoped to its run. Existing subprocess time/output safety limits still apply: cancellation or exceeding the transport cap can prevent complete capture, and arbitrary terminal output should not be assumed secret-free. No compressed excerpt is evidence that an omitted fact was verified.

## Verification

Run `pnpm check` and `node scripts/check-app.mjs`. Tests cover grammar rejection, graph errors, no-model local routes, immutable prompts, stable HTTP request prefixes, bounded compression, exact evidence recovery, structured failed-command output, worker restart/cancellation, and existing browser and Windows control behavior. The smoke test uses a disposable profile and self-owned windows.

Windows Core Audio volume changes are covered with adapter mocks; actual endpoint changes and read-back still need a manual test with a working playback device. Try `volume up by 1`, confirm the Windows volume slider moves by one percentage point (unless already at 100%), then restore your preferred volume. Signed packaged-app installation remains separately blocked as documented in README.md.
