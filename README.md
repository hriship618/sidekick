# Rove

Rove is a local Windows desktop assistant. Summon the floating command bar with **Ctrl+Alt+Space**. Describe a task and press Enter. Open Workspace for recent tasks and settings. Straightforward `close <app>` commands, explicit resource launches, and saved launch routines execute locally without a model; other natural-language work uses your configured connection.

## Install and reopen

The project includes per-user Windows installer configuration: `pnpm dist:win` builds `release/Rove-Setup-0.2.0.exe`. A successful installer creates Start-menu and desktop shortcuts named **Rove** and an entry in Windows Installed apps. A second launch reopens the existing instance. No Node.js installation is required to run the installed app.

**Installation status on this machine:** Windows Smart App Control blocks the unsigned packaged Rove executable (Code Integrity event 3077), and the installer build cannot execute its temporary uninstaller-generation stage. Rove has **not** been installed. The incomplete installer was removed. A trusted signed release is needed to complete installation under the current policy; security settings were not changed. Use `pnpm dev` for the verified development build in the meantime.

The tray menu includes **Bring companion back** and **Quit Rove**. Hiding/minimizing the launcher returns the corner companion. A missing/unresponsive UI is replaced with a fresh window while execution remains in the main process. Lifecycle diagnostics are local under the user-data `logs` directory. A Windows-blocked native addon is optional and cannot prevent startup; the app uses its Windows helper fallback without changing security policy.

Existing Sidekick profiles are preserved in `%APPDATA%\Sidekick`, including `sidekick.sqlite`, Chromium protection state, browser sessions, and protected credentials. Rove retains that storage path for compatibility. Uninstalling does not delete these profiles.

The planned learning engine is described in [Action graph plan](docs/ACTION_GRAPH_PLAN.md). Learned graph replay is not implemented yet.

## Develop on Windows

Install Node.js 24.15 or later and pnpm 11. For SSH workspaces, install Windows Terminal with its `wt.exe` app execution alias enabled, and install the Windows OpenSSH Client optional feature.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and launches Electron. Restart it after source edits. Escape and the window close button hide Rove while active work continues. Summon it again to return to an active task. Click its tray icon to reopen it or right-click the icon and choose **Quit Rove** to exit.

```powershell
pnpm check
```

This runs TypeScript checks, Node tests, and the production build. Tests use real SQLite databases and simulated OS dispatchers to cover setup, validation, SSH arguments, duplicate run prevention, partial failure, cancellation, confirmation, and recovery.

## Connect AI and browser

1. Open **Settings → AI connection**. Choose **Continue with ChatGPT**, then sign in and approve plan access in your browser.
2. Return to Rove and use **Test ChatGPT connection**. Rove lists models available to your account. **Manage usage** opens your ChatGPT limits and credit settings. You can explicitly choose the separately billed API key connection if you want to use it. Rove keeps using the selected connection when a request fails.
3. Use **Open Rove browser** to start Microsoft Edge with Rove’s dedicated profile. It retains site sessions where supported and uses a separate profile from everyday browsing.
4. Summon Rove and try “In the Rove browser, open https://example.com and tell me its main heading.” For a missing detail, reply in the task card. If sign-in is required, use **Open browser**, sign in directly in Edge, summon Rove, and select **Resume**. Requested navigation, ordinary form editing, resource files, and SSH launches proceed under task authorization. Rove asks when a control has an unclear effect or the action exceeds the request. Explicit review boundaries are checked for individual actions and batches.

Model tasks send your command, answers, and relevant browser evidence to OpenAI. Rove keeps the execution trace, longer page excerpts, and requested screenshots in the local database. Only the current goal, user answers, compact action summaries, and recent or explicitly requested evidence are used for model context. Keep passwords and other secrets out of task text and answers. Use the site itself for credentials and other sensitive fields.

You can also use `open https://example.com` or `open C:\Users\you\Documents` with your own URL or path. Executable content can require a scoped approval. Requested documents and folders open directly.

The companion defaults to the taskbar edge with its head peeking out. Starting a task immediately dismisses the launcher and leaves the working animation in the corner. Hover gently lifts its head and reveals details after a brief pause. Move away to hide details again. Drag to pull the creature out or move it; summoning Rove and starting tasks preserve its position. Progress, questions, errors, and completion never open a bubble automatically. Click the creature or its hover bubble to answer a question, review details, or cancel. Transparent areas pass clicks to other applications, and the host stays clear of the taskbar. In **Settings**, choose its preferred side, enable quiet mode, hide the companion, or turn off its animations. Rove also follows the system’s reduced-motion preference. An action already handed off to Windows can finish after cancellation.

The compact launcher combines its input, workspace/settings controls, provider, and key hints in two short rows. Opening it warps the companion into a miniature on its top edge, where it occasionally walks in either direction while you type. Escape returns it to the corner without cancelling work. Dropping a dragged creature back at the taskbar clears its speech bubble, restores the head-peeking state, and waits for the pointer to leave before showing hover details again. The completion hop returns to idle blinking afterward.

On Windows, companion dragging detects a fresh primary-button press on visible sprite pixels and tracks the desktop cursor in the main process. It does not require a renderer mouse-down or pointer capture. Native window regions keep the head clickable while transparent areas pass clicks through. Pull it out, move it anywhere within the display, and release near the taskbar to tuck it in at that horizontal position. `pnpm test:drag` exercises the native Electron drag loop with controlled pointer observations, including missing renderer events, capture loss, and left-to-right redocking, without moving the system pointer.

Run `pnpm test:overlay` for the disposable-profile Electron regression check. On Windows it inspects native mouse transparency and window regions, verifies hover and tuck behavior, checks taskbar exclusion and launcher focus, and executes a task with a simulated OS URL dispatcher. Set `SIDEKICK_TEST_SCALE` to `1`, `1.25`, `1.5`, or `2` to exercise different scaling settings. It does not move the system pointer.

**Desktop access** is enabled by default in Settings. The model can enumerate windows and processes, inspect accessibility controls, focus or gracefully close an observed window, invoke and fill supported controls, stop a requested process, and run PowerShell for general local tasks. Try “Close Notepad” with a disposable Notepad window or “List the running applications.” Closing uses [Windows WM_CLOSE](https://learn.microsoft.com/windows/win32/winmsg/wm-close) so applications can present save dialogs; the result distinguishes a closed window from an exited process. Control actions use [Windows UI Automation patterns](https://learn.microsoft.com/dotnet/framework/ui-automation/ui-automation-control-patterns-overview). Apps expose different levels of accessibility support, so inspection can report unsupported controls. PowerShell provides a general fallback with bounded execution time, structured results, and cancellation. Large results are stored as local evidence and retrieved in excerpts.

Desktop tools run only in the main process, accept validated structured inputs over a private adapter, and pass request data through stdin rather than interpolating command arguments. They inherit the signed-in Windows account’s access; enabling this setting does not bypass UAC, administrator restrictions, application protections, or save dialogs. The renderer remains sandboxed and has no raw command-execution IPC. Explicit task boundaries still apply.

Application discovery matches executable product names and descriptions as well as window titles and process names. Desktop observations remain available across model turns, including intervening progress updates. Larger window lists prioritize identities relevant to the current request and retain full evidence locally. Repeated discovery without an intervening change reuses marked cached evidence, prompts the model to act or clarify, and stops with a specific explanation if it continues looping. A verified closed window is sufficient to finish a window-close request even if its background process remains.

Save named routines under **Settings → Saved routines**. Add resource URLs or local paths and an optional existing SSH alias with its remote directory. Enter the saved name in the launcher to run those exact steps. No sample course configuration is required.

## Execution details

- Electron's main process owns SQLite, shortcut registration, and Windows dispatch. The sandboxed React renderer uses fixed IPC requests and receives snapshots and summon notifications. The main process checks the frame and validates inputs.
- Tool definitions include input and output schemas, their verification level, and whether another dispatch may duplicate the action. Browser and local actions confirm dispatch to the OS. The SSH action observes the launcher, while remote authentication and directory verification happen in the terminal. Rove records each result and never automatically retries a launch.
- Supply an existing SSH alias and a remote directory in your task. Rove asks for approval before launching. The SSH alias is passed to Windows OpenSSH as a separate argument. The remote command changes into the configured directory and starts an interactive POSIX shell. Aliases accept letters, digits, underscores, dots, and hyphens, with an initial letter or digit. Remote paths accept letters, digits, spaces, dots, slashes, underscores, and hyphens. Rove uses the existing SSH configuration, keys, agent, and host-key checks.
- SQLite data, including protected model credentials and local task evidence, lives in `sidekick.sqlite` under `%APPDATA%\Sidekick` for upgrade compatibility. The history shows the latest 20 runs. Commands, noncredential settings, and task evidence are stored locally in plaintext. The dedicated Edge profile lives beside the database.

## License

[MIT](LICENSE)
