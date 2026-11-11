# Sidekick

Sidekick is a local Windows desktop assistant. Summon the floating command bar with **Ctrl+Alt+Space**. Describe a task and press Enter. The task card shows progress and recovery actions. Open Workspace for recent tasks and settings. Sidekick can run natural-language tasks with an OpenAI model. Explicit open commands also work without a model.

## Develop on Windows

Install Node.js 24.15 or later and pnpm 11. For SSH workspaces, install Windows Terminal with its `wt.exe` app execution alias enabled, and install the Windows OpenSSH Client optional feature.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and launches Electron. Restart it after source edits. Escape and the window close button hide Sidekick while active work continues. Summon it again to return to an active task. Click its tray icon to reopen it or right-click the icon and choose **Quit Sidekick** to exit.

```powershell
pnpm check
```

This runs TypeScript checks, Node tests, and the production build. Tests use real SQLite databases and simulated OS dispatchers to cover setup, validation, SSH arguments, duplicate run prevention, partial failure, cancellation, confirmation, and recovery.

## Connect AI and browser

1. Open **Settings → AI connection**. Choose **Continue with ChatGPT**, then sign in and approve plan access in your browser.
2. Return to Sidekick and use **Test ChatGPT connection**. Sidekick lists models available to your account. **Manage usage** opens your ChatGPT limits and credit settings. You can explicitly choose the separately billed API key connection if you want to use it. Sidekick keeps using the selected connection when a request fails.
3. Use **Open Sidekick browser** to start Microsoft Edge with Sidekick’s dedicated profile. It retains site sessions where supported and uses a separate profile from everyday browsing.
4. Summon Sidekick and try “In the Sidekick browser, open https://example.com and tell me its main heading.” For a missing detail, reply in the task card. If sign-in is required, use **Open browser**, sign in directly in Edge, summon Sidekick, and select **Resume**. Sidekick asks before clicking a page control, filling a field, or opening a local item.

Model tasks send your command, answers, and relevant browser evidence to OpenAI. Sidekick keeps the execution trace, longer page excerpts, and requested screenshots in the local database. Only the current goal, user answers, compact action summaries, and recent or explicitly requested evidence are used for model context. Keep passwords and other secrets out of task text and answers. Use the site itself for credentials and other sensitive fields.

You can also use `open https://example.com` or `open C:\Users\you\Documents` with your own URL or path. The task card asks for approval before opening a local item because file associations may launch executable content.

In **Settings**, you can hide the companion or turn off its animations. Sidekick also follows the system’s reduced-motion preference. Use **Cancel task** to stop the remaining steps. An action already handed off to Windows can finish.

## Execution details

- Electron's main process owns SQLite, shortcut registration, and Windows dispatch. The sandboxed React renderer uses fixed IPC requests and receives snapshots and summon notifications. The main process checks the frame and validates inputs.
- Tool definitions include input and output schemas, their verification level, and whether another dispatch may duplicate the action. Browser and local actions confirm dispatch to the OS. The SSH action observes the launcher, while remote authentication and directory verification happen in the terminal. Sidekick records each result and never automatically retries a launch.
- Supply an existing SSH alias and a remote directory in your task. Sidekick asks for approval before launching. The SSH alias is passed to Windows OpenSSH as a separate argument. The remote command changes into the configured directory and starts an interactive POSIX shell. Aliases accept letters, digits, underscores, dots, and hyphens, with an initial letter or digit. Remote paths accept letters, digits, spaces, dots, slashes, underscores, and hyphens. Sidekick uses the existing SSH configuration, keys, agent, and host-key checks.
- SQLite data, including protected model credentials and local task evidence, lives in `sidekick.sqlite` under Electron's Sidekick user data directory, usually `%APPDATA%\Sidekick`. The history shows the latest 20 runs. Commands, noncredential settings, and task evidence are stored locally in plaintext. The dedicated Edge profile lives beside the database.

## License

[MIT](LICENSE)



