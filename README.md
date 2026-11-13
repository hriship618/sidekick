# Rove

**An open-source Windows assistant built around research in efficient AI agents.**

Describe the outcome you want. Rove works across browser pages, local files, Windows apps, and SSH workspaces, shows real progress, and asks when it needs a detail. Press **Ctrl+Alt+Space** to summon it; the companion stays quietly by your taskbar while it works.

## The idea: stop making AI rethink every step

A useful assistant should get things done with fewer model calls and less repeated context. Rove separates **planning, execution, and evidence**:

1. **Route locally when possible.** Saved routines and supported commands run without a cloud model.
2. **Execute a graph of steps.** For unfamiliar work, the model can supply a plan with explicit dependencies. The local engine orders the steps, runs checks, and stops when a step fails.
3. **Keep the model's context small.** Long results stay on your PC. The model gets compact observations and can retrieve missing details.
4. **Reuse a stable prompt prefix.** Instructions and tool definitions stay unchanged during a task, making provider prefix-cache reuse possible.

These paths are wired into the launcher and execution engine. Expand **Execution details** to see model calls, graph usage, reported token/cache counts, and context reduction when available.

## Research in practice

| Research | What Rove implements |
| --- | --- |
| [Graph-based agent planning — Wu et al., NeurIPS 2024](https://arxiv.org/abs/2405.19119) | An executable dependency graph for model plans, batches, and saved routines. Invalid graphs execute nothing; failed steps block further work. Rove uses deterministic routing, not the paper's GNN. |
| [Trajectory reduction / AgentDiet — Xiao et al., 2025; revised 2026](https://arxiv.org/abs/2509.23586) | Bounded observations, a compact recent history, and full evidence stored locally. This is an extractive adaptation, not a reproduction of AgentDiet. |
| [Flow Engineering / AlphaCodium — Ridnik et al., 2024](https://arxiv.org/abs/2401.08500) | Separation of planning, execution, and tool-level verification. Rove is a desktop assistant, not AlphaCodium's coding system. |
| [Provider prefix caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Stable instructions and tool schemas, a cache key for the standard API, and reported cache-usage metrics. Actual cache hits depend on the provider. |

**Next:** learn reusable procedures from successful tasks, inspired by [Agent Workflow Memory](https://arxiv.org/abs/2409.07429). User-created routines work today; automatic workflow learning is still planned.

## What can I use it for?

- Prepare a project workspace from a saved routine: its documents, reference links, and SSH workspace together.
- Work through browser tasks with navigation, inspection, form editing, and checks between dependent steps.
- Combine Windows actions and local resources in a natural-language task, with a question when the target is unclear.

Rove is early software. It does not reliably automate every application or website yet.

## Try it on Windows

Install **Node.js 24.15+** and **pnpm 11**, then:

```powershell
git clone https://github.com/hriship618/sidekick.git
cd sidekick
pnpm install --frozen-lockfile
pnpm dev
```

Use the launcher's **Settings** button to connect ChatGPT if your account supports access, or enter an OpenAI API key. API usage is billed separately. Open **Rove browser** in Settings for web tasks, and create repeatable workflows under **Saved routines**.

AI tasks send your request and relevant task information to OpenAI. History and full evidence stay locally; credentials use Windows protection where available. Rove is not fully offline.

**Installer:** Windows Smart App Control blocked the unsigned build on the development machine. A working signed installer is not available yet.

## Results and development

Local benchmarks showed a **141 ms median** warm app close with **zero model calls**, and a **7.0× faster** warm Windows helper than starting a fresh helper per action. These are small local measurements, not general task-speed or token-savings claims. Live provider savings remain unmeasured.

`pnpm check` runs checks and tests. `pnpm benchmark` measures local performance without cloud requests.

[Benchmarks](docs/benchmarks/README.md) · [Research and implementation](docs/RESEARCH.md) · [Architecture](docs/FLOW_ARCHITECTURE.md) · [Development](docs/DEVELOPMENT.md) · [Learning plan](docs/ACTION_GRAPH_PLAN.md)

[MIT license](LICENSE)
