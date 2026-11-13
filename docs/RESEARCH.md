# Research behind Rove

Rove applies ideas from agent research to a Windows assistant. These are engineering adaptations, not reproductions of the papers' systems or claims that their benchmark results transfer to Rove. Several foundational papers are from 2024; presenting all of them as 2025–2026 research would be inaccurate.

## Graph-based planning

**Xixi Wu et al. (NeurIPS 2024), [Can Graph Learning Improve Planning in LLM-based Agents?](https://arxiv.org/abs/2405.19119).** The paper represents subtasks and their dependencies as a graph and investigates GNN-based subtask retrieval and planning.

Rove's adaptation is an executable dependency graph, implemented in [execution-graph.ts](../src/execution-graph.ts). It validates node IDs, prerequisites and cycles before dispatch, computes a stable topological order, executes through the existing validated tools, stops on the first failed result, and returns completed, failed and blocked node IDs. Execution is sequential because browser navigation and desktop focus share mutable state. Graphs are not automatically retried.

This is in the app's real execution path:

- A model can call `execute_graph` for a known multi-step task.
- Existing `batch` calls compile to linear graphs using the same interpreter.
- Named routines selected in the launcher run through the graph interpreter without model calls.
- Browser nodes with dependents require explicit expected-state checks; a dependent click requires an expected visible element. The browser adapter verifies them before later nodes run.
- Graph plans, checkpoints and completion receipts are persisted in the run's SQLite trace. The app marks blocked routine steps as skipped.

The existing conservative [local router](../src/local-router.ts) remains the entry path for known single commands. It uses TF-IDF candidate ranking plus strict parameter/grammar admission. It is not a trained GNN, a probabilistically calibrated semantic classifier, or general A* planning over all Windows actions. The model still solves unfamiliar work, and may inspect or ask questions outside a graph when the next steps are not known.

## Trajectory reduction

**Yuan-An Xiao, Pengfei Gao, Chao Peng and Yingfei Xiong, [Reducing Cost of LLM Agents with Trajectory Reduction](https://arxiv.org/abs/2509.23586v2).** Initially released in September 2025 under the title *Improving the Efficiency of LLM Agent Systems through Trajectory Reduction*, revised March 2026 and accepted for FSE 2026. AgentDiet targets useless, redundant and expired trajectory information during execution.

Rove uses an extractive policy in [trajectory.ts](../src/trajectory.ts) and [agent.ts](../src/agent.ts): shell strings are bounded, the recent action ledger is capped, oversized tool results point to locally stored evidence, and obsolete desktop observations are cleared after desktop mutations. Goals, constraints and answers stay in context. The model can request bounded evidence excerpts when needed. Full stdout/stderr and their exit status stay available locally within subprocess transport limits.

This is not the paper's complete reduction algorithm. Rove does not run a second summarizing model or assume that truncation preserves task accuracy. Our synthetic character-reduction result is distinct from AgentDiet's token/cost results. Browser tasks need matched success-and-cost evaluations before claiming equivalent gains.

## Flow Engineering

**Tal Ridnik, Dedy Kredo and Itamar Friedman (2024), [Code Generation with AlphaCodium: From Prompt Engineering to Flow Engineering](https://arxiv.org/abs/2401.08500).** AlphaCodium studies a test-based, multi-stage coding flow.

Rove separates model planning from deterministic dispatch and tool-level verification. Missing information is handled through the existing task question/resume flow; failed graph checks return evidence instead of continuing blindly. It does not implement AlphaCodium's competitive-programming pipeline or an independent LLM checker, and it does not force verbose scratchpad output.

## Prefix caching

The implementation follows the provider's [prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching), rather than attributing automatic API caching to the ReAct paper.

[PromptManager](../src/prompt-manager.ts) snapshots and canonicalizes static instructions and tool definitions for a model session. User goals, timestamps, observations and recent history occupy the dynamic suffix. The standard API adapter passes a static-prefix-derived cache key; ChatGPT plan access retains its supported request shape. Reported input, output and cached-input tokens are persisted. A stable prefix enables potential provider reuse; it does not guarantee cache residency, a hit, or a fixed latency reduction. No inference server or GPU-routing layer is part of this desktop deployment.

## Workflow memory: next stage

**Zora Zhiruo Wang, Jiayuan Mao, Daniel Fried and Graham Neubig (2024), [Agent Workflow Memory](https://arxiv.org/abs/2409.07429).** AWM induces reusable workflows from previous experience and retrieves them to guide later tasks.

Rove currently reuses user-created routines. It does not yet induce or automatically approve new executable procedures from successful runs. The shared graph runtime and persisted checkpoints are foundations for that work; the versioned candidate/review/replay design is in [ACTION_GRAPH_PLAN.md](ACTION_GRAPH_PLAN.md). Merely storing a trace or topologically ordering nodes is not workflow learning.

## Inspect the implementation

The app's expandable **Execution details** shows model-call count, graph-plan count, provider-reported token/cache usage when present, and shortened observation characters. These are measured execution facts, not estimated billing or research benchmark gains. Older uninstrumented runs do not acquire invented metrics. The model loop, saved routines and local commands all enter through the launcher's existing narrow IPC; privileged execution remains in Electron's main process.

Tests cover invalid graphs executing nothing, dependency order, failed prerequisites, cancellation, blocked routine steps, a real Edge form task with a fixture provider, stable prompt payloads, retrievable evidence, and actual metrics reaching the UI. No live provider credits are spent by the test suite.
