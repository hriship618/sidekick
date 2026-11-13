# Rove

**A little Windows companion that gets things done.**

Press **Ctrl+Alt+Space**, type what you need, and Rove gets to work. It stays quietly by your taskbar while you use your computer. Hover or click the creature to check progress, answer a question, or stop a task.

## What can it do?

- Open websites, files, and folders.
- Close apps and adjust your volume.
- Browse pages, click buttons, and fill in forms in its own browser.
- Launch SSH workspaces and run saved routines.
- Ask a quick question when it needs more information, then continue.

Try **“close Notepad”**, **“volume up by 5”**, or **“open https://example.com”**.

## Why Rove?

- **Quick for everyday tasks.** Supported simple commands run directly on your PC, without waiting for AI. Warm app closes took about **138 ms** in our local benchmark.
- **Less back-and-forth with AI.** For harder tasks, Rove sends compact results and keeps long logs locally, ready to retrieve when needed.
- **Easy to stay out of your way.** A small launcher, a quiet companion, and details only when you want them.
- **Open source.** Your routines, settings, and task history are stored on your computer.

**Next:** learning reusable routines from successful tasks, so repeated work needs less AI. Automatic learning is still planned—not shipped yet.

## Try it

Rove is an early Windows app. For now, run it from source with **Node.js 24.15+** and **pnpm 11**:

```powershell
git clone https://github.com/hriship618/sidekick.git
cd sidekick
pnpm install --frozen-lockfile
pnpm dev
```

Open the launcher's **Settings** button to connect AI. Choose **Continue with ChatGPT** if your account supports access, or enter an OpenAI API key. API usage is billed separately. Simple local commands work without an AI connection.

For web tasks, open **Rove browser** in Settings. It uses a separate Microsoft Edge profile, where you can sign in to websites yourself.

**Installer status:** packaging is set up, but Windows Smart App Control blocked the unsigned build on the development machine. A working signed installer is not available yet.

## A few things to know

- AI tasks send your request and relevant task information to OpenAI. Rove is not fully offline.
- Local history and logs stay on your PC. Credentials use Windows protection where available.
- Escape hides the launcher without stopping a task. Use the tray menu to reopen or quit Rove.
- This is early software. Check important results and expect rough edges.

## For developers

`pnpm check` runs checks, tests, and a build. `pnpm benchmark` measures local performance without cloud requests.

[Development guide](docs/DEVELOPMENT.md) · [Benchmarks](docs/benchmarks/README.md) · [Architecture](docs/FLOW_ARCHITECTURE.md) · [Learning plan](docs/ACTION_GRAPH_PLAN.md)

Local benchmarks are from a small test set, not a promise for every task. Live provider token savings and cache speedups have not been measured.

[MIT license](LICENSE)
