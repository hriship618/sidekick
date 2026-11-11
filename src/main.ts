import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { commandSchema, settingsSchema, surfaceSchema, type Snapshot, type Settings, type Surface } from './contracts.ts';
import { Store } from './store.ts';
import { createRegistry } from './tools.ts';
import { explain, Runner } from './runner.ts';
import { BrowserSession } from './browser.ts';
import { chatGPTModel, openAIModel, testModel } from './model.ts';
import { pasteKey, readKey, requestKey } from './credentials.ts';
import { ChatGPTConnection } from './chatgpt.ts';

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let store: Store | undefined;
let registered = '';
let surface: Surface = 'command';
let runner: Runner | undefined;
let browser: BrowserSession | undefined;
let cancelSignIn = () => {};
let publish = () => {};
const dimensions = { command: [580, 212], task: [580, 460], workspace: [920, 680] } as const;
let shortcutWarning = '';
const indexPath = join(__dirname, 'index.html');
const indexUrl = pathToFileURL(indexPath).href;

function layout(next: Surface, atCursor = false) {
  if (!window) return;
  const previous = surface;
  surface = next;
  const bounds = window.getBounds();
  const display = atCursor ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const [preferredWidth, preferredHeight] = dimensions[next];
  const width = Math.min(preferredWidth, area.width - 16);
  const height = Math.min(preferredHeight, area.height - 16);
  const center = atCursor || previous === 'workspace' || next === 'workspace';
  const x = center ? area.x + Math.round((area.width - width) / 2) : bounds.x;
  const y = center ? area.y + Math.round((area.height - height) * (next === 'workspace' ? .5 : .24)) : bounds.y;
  window.setAlwaysOnTop(next !== 'workspace');
  window.setBounds({
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width, height,
  });
}

function show(next: Surface, atCursor = false) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  layout(next, atCursor);
  publish();
  window.show();
  window.focus();
  window.webContents.focus();
  window.webContents.send('sidekick:summon');
}

function summon() {
  show(runner?.active() ? 'task' : 'command', true);
}


function register(shortcut: string) {
  if (shortcut === registered) return;
  if (!globalShortcut.register(shortcut, summon)) throw new Error(`${shortcut} is unavailable. Choose another shortcut.`);
}

async function launchTerminal(args: string[]) {
  if (process.platform !== 'win32') throw new Error('SSH workspaces require Windows Terminal on Windows.');
  const terminal = join(process.env.LOCALAPPDATA ?? join(app.getPath('appData'), '..', 'Local'), 'Microsoft', 'WindowsApps', 'wt.exe');
  const ssh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  await access(ssh).catch(() => { throw new Error('Install the Windows OpenSSH Client optional feature.'); });
  // Windows Terminal treats semicolons as command separators. Neither validated SSH input can contain one.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(terminal, ['-w', '0', 'new-tab', ssh, ...args], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', error => reject(new Error(`Could not launch Windows Terminal (${error.message}). Install it and enable the wt.exe app execution alias.`)));
    // A new Terminal window can keep this process alive. Observe immediate failures
    // without tying the run to the lifetime of the window or the SSH process.
    const timer = setTimeout(() => { child.unref(); resolve(); }, 1200);
    child.once('error', () => clearTimeout(timer));
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Windows Terminal launcher exited with code ${code ?? 'unknown'}.`));
    });
  });
}

async function start() {
  const db = new Store(join(app.getPath('userData'), 'sidekick.sqlite'));
  store = db;
  const session = new BrowserSession(join(app.getPath('userData'), 'browser-profile'));
  browser = session;
  let credentialBusy = false;
  let accountBusy = false;
  const chatgpt = new ChatGPTConnection(db, {
    protection: {
      async encrypt(value) {
        if (process.platform !== 'win32' || !await safeStorage.isAsyncEncryptionAvailable()) {
          throw new Error('Windows credential protection is unavailable.');
        }
        return safeStorage.encryptStringAsync(value);
      },
      async decrypt(value) { return (await safeStorage.decryptStringAsync(value)).result; },
    },
    async openBrowser(url) {
      if (new URL(url).origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in destination.');
      await shell.openExternal(url);
    },
    publish: () => publish(),
  });
  await chatgpt.initialize();
  cancelSignIn = () => chatgpt.cancel();

  async function planModel(settings: Settings) {
    if (!chatgpt.status().models.length) await chatgpt.refreshModels();
    const state = chatgpt.status();
    const choice = state.models.find(item => item.slug === settings.chatgptModel) ?? state.models[0];
    if (!choice) throw new Error(state.notice || 'No ChatGPT model is available. Open Settings and check your connection.');
    return chatGPTModel(signal => chatgpt.accessToken(state.selectedId, signal), choice.slug);
  }
  const snapshot = (): Snapshot => {
    const settings = db.settings();
    return { settings, runs: db.recent(), shortcutWarning, surface, active: runner?.active() ?? null, credentialSaved: db.hasCredential(), chatgpt: chatgpt.status() };
  };
  publish = () => {
    if (window && !window.isDestroyed()) window.webContents.send('sidekick:update', snapshot());
  };

  const registry = createRegistry({
    openUrl: url => shell.openExternal(url),
    async openPath(path) {
      await stat(path).catch(() => { throw new Error('Windows could not find or read that local path.'); });
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
    launchTerminal,
  });
  const engine = new Runner(db, registry, publish, {
    configured: () => db.settings().connectionMode === 'chatgpt' ? chatgpt.status().sharing : db.hasCredential(),
    model: async settings => settings.connectionMode === 'chatgpt'
      ? planModel(settings) : openAIModel(await readKey(db), settings.model),
    browser: session,
  });
  runner = engine;
  const handle = (channel: string, handler: (value: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
          || event.senderFrame?.url !== indexUrl) throw new Error('Untrusted IPC sender.');
      const expected = ['sidekick:snapshot', 'sidekick:hide', 'sidekick:browser'].includes(channel) ? 0 : 1;
      if (args.length !== expected) throw new Error('Invalid IPC arguments.');
      try { return await handler(args[0]); }
      catch (error) { throw new Error(explain(error)); }
    });
  };
  handle('sidekick:snapshot', snapshot);
  handle('sidekick:hide', () => window?.hide());
  handle('sidekick:show', value => show(surfaceSchema.parse(value)));
  handle('sidekick:cancel', value => engine.cancel(z.string().uuid().parse(value)));
  handle('sidekick:answer', value => {
    const { id, answer } = z.strictObject({ id: z.string().uuid(), answer: z.union([z.boolean(), z.string().trim().min(1).max(600)]) }).parse(value);
    engine.answer(id, answer);
  });
  handle('sidekick:credential', async value => {
    const action = z.enum(['set', 'paste', 'clear', 'test']).parse(value);
    if (credentialBusy) throw new Error('A credential operation is already running.');
    credentialBusy = true;
    try {
      if (action === 'test') {
        const settings = db.settings();
        await testModel(openAIModel(await readKey(db), settings.model));
        return 'OpenAI connection and tool calling verified.';
      }
      if (action === 'set' && !await requestKey(db)) return 'Key entry cancelled.';
      if (action === 'paste') await pasteKey(db);
      if (action === 'clear') db.saveCredential();
      publish();
      return action === 'clear' ? 'Saved API key removed.' : 'API key saved with Windows protection.';
    } finally { credentialBusy = false; }
  });
  handle('sidekick:chatgpt', async value => {
    const input = z.union([
      z.strictObject({ action: z.enum(['signIn', 'addAccount', 'cancel', 'signOut', 'refresh', 'test', 'usage', 'dismiss']) }),
      z.strictObject({ action: z.literal('select'), id: z.string().uuid() }),
    ]).parse(value);
    if (input.action === 'cancel') { chatgpt.cancel(); return ''; }
    if (input.action === 'dismiss') { chatgpt.dismissWelcome(); return ''; }
    if (input.action === 'usage') { await shell.openExternal('https://chatgpt.com/settings/usage'); return ''; }
    if (accountBusy || engine.active()) throw new Error('Finish the current task or account action first.');
    accountBusy = true;
    try {
      if (input.action === 'signIn' || input.action === 'addAccount') {
        db.save({ ...db.settings(), connectionMode: 'chatgpt' });
        await chatgpt.signIn(input.action === 'addAccount');
        return chatgpt.status().sharing ? 'ChatGPT plan access is enabled.' : '';
      }
      if (input.action === 'select') await chatgpt.select(input.id);
      if (input.action === 'signOut') await chatgpt.signOut();
      if (input.action === 'refresh') await chatgpt.refreshModels();
      if (input.action === 'test') {
        await testModel(await planModel(db.settings()));
        return 'ChatGPT plan connection and tool calling verified.';
      }
      return '';
    } finally { accountBusy = false; publish(); }
  });
  handle('sidekick:browser', async () => {
    await session.open();
    window?.hide();
  });
  handle('sidekick:run', value => {
    if (accountBusy) throw new Error('Finish or cancel the ChatGPT account action first.');
    const command = commandSchema.parse(value);
    const running = engine.run(command);
    show('task');
    return running;
  });
  handle('sidekick:settings', value => {
    const next = settingsSchema.parse(value);
    if (accountBusy && next.connectionMode !== db.settings().connectionMode) throw new Error('Finish or cancel the ChatGPT account action first.');
    const previous = registered;
    const changed = next.shortcut !== db.settings().shortcut;
    if (changed) register(next.shortcut);
    try { db.save(next); }
    catch (error) {
      if (changed && next.shortcut !== previous) globalShortcut.unregister(next.shortcut);
      throw error;
    }
    if (changed) {
      if (previous && previous !== next.shortcut) globalShortcut.unregister(previous);
      registered = next.shortcut;
      shortcutWarning = '';
    }
    publish();
    return next;
  });

  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: dimensions.command[0], height: dimensions.command[1], show: false, title: 'Sidekick',
    backgroundColor: '#201d1c', frame: false, resizable: false, maximizable: false, autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); window?.hide(); }
  });
  window.once('ready-to-show', summon);
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Sidekick');
  tray.on('click', summon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sidekick', click: summon },
    { label: 'Open workspace', click: () => show('workspace', true) },
    { label: 'Quit Sidekick', click: () => app.quit() },
  ]));
  const configured = db.settings().shortcut;
  try { register(configured); registered = configured; }
  catch (error) { shortcutWarning = explain(error); }
  await window.loadFile(indexPath);
  if (chatgpt.status().sharing) void chatgpt.refreshModels();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', summon);
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    cancelSignIn();
    if (!browser) return;
    event.preventDefault();
    const active = runner?.active();
    if (active) runner?.cancel(active.id);
    const timeout = setTimeout(() => app.quit(), 3000);
    void browser.close().catch(() => {}).finally(() => { clearTimeout(timeout); app.quit(); });
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Sidekick could not start', explain(error));
    app.quit();
  });
}

