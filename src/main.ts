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
import { DesktopCompanion } from './desktop-companion.ts';
import { lifecycleLog, recoverRenderer, rendererHeartbeat } from './recovery.ts';
import { DesktopWorker } from './desktop-worker.ts';
import { primaryButtonReader } from './windows-pointer.ts';

app.setName('Rove');
// Keep the Chromium key store, SQLite database and browser sessions at their original path.
// Explicit profiles (tests and development sandboxes) remain fully isolated.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'Sidekick'));
if (process.platform === 'win32') app.setAppUserModelId('io.rove.desktop');

let window: BrowserWindow | undefined;
let companion: DesktopCompanion | undefined;
let collapseTimer: ReturnType<typeof setTimeout> | undefined;
let tray: Tray | undefined;
let quitting = false;
let store: Store | undefined;
let registered = '';
let surface: Surface = 'command';
let runner: Runner | undefined;
let browser: BrowserSession | undefined;
let desktopWorker: DesktopWorker | undefined;
let cancelSignIn = () => {};
let publish = () => {};
let restoreMain = () => {};
const dimensions = { command: [540, 128], task: [580, 460], workspace: [920, 680] } as const;
let shortcutWarning = '';
const indexPath = join(__dirname, 'index.html');
const indexUrl = pathToFileURL(indexPath).href;

function layout(next: Surface, atCursor = false) {
  if (!window) return;
  const previous = surface;
  surface = next;
  try { window.setShape([]); } catch { /* Unsupported platforms retain the compact native bounds. */ }
  if (next !== 'workspace' && companion) {
    window.setAlwaysOnTop(true);
    const height = dimensions[next][1] - (next === 'command' && !store?.settings().showCompanion ? 32 : 0);
    window.setBounds(companion.panel(dimensions[next][0], height, atCursor));
    return;
  }
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
  clearTimeout(collapseTimer);
  layout(next, atCursor);
  companion?.launcher(next === 'command');
  publish();
  window.show();
  window.focus();
  window.webContents.focus();
  window.webContents.send('sidekick:summon');
}

function summon() {
  if (!window || window.isDestroyed()) { restoreMain(); return; }
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
  const logs = join(app.getPath('userData'), 'logs');
  lifecycleLog(logs, 'start', { version: app.getVersion(), packaged: app.isPackaged });
  const helper = (name: string) => app.isPackaged ? join(process.resourcesPath, name) : join(__dirname, name);
  const worker = new DesktopWorker(helper('windows-desktop.ps1'));
  desktopWorker = worker;
  void worker.execute({ operation: { action: 'listWindows', query: 'Rove' } }).catch(() => lifecycleLog(logs, 'desktop-helper-unavailable'));
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
    return { settings, runs: db.recent(), shortcutWarning, surface, active: runner?.active() ?? null, credentialSaved: db.hasCredential(), chatgpt: chatgpt.status(), companion: companion?.snapshot() ?? { x: 0, y: 0, fromX: 0, fromY: 0, sequence: 0, moving: false } };
  };
  publish = () => {
    const state = snapshot();
    if (window && !window.isDestroyed()) window.webContents.send('sidekick:update', state);
    if (companion && !companion.window.isDestroyed()) companion.window.webContents.send('sidekick:update', state);
  };

  const registry = createRegistry({
    openUrl: url => shell.openExternal(url),
    async openPath(path) {
      await stat(path).catch(() => { throw new Error('Windows could not find or read that local path.'); });
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
    launchTerminal,
    desktop: async (input, signal) => {
      if (!db.settings().desktopAccess) throw new Error('The desktop access setting is off. Enable Desktop access in Settings to use Windows controls.');
      return worker.execute(input, signal);
    },
  });
  const engine = new Runner(db, registry, publish, {
    fastDesktop: true,
    configured: () => db.settings().connectionMode === 'chatgpt' ? chatgpt.status().sharing : db.hasCredential(),
    model: async settings => settings.connectionMode === 'chatgpt'
      ? planModel(settings) : openAIModel(await readKey(db), settings.model),
    browser: session,
  });
  runner = engine;
  const handle = (channel: string, handler: (value: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const isPanel = window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === indexUrl;
      const isCompanion = companion && event.sender === companion.window.webContents
        && event.senderFrame === companion.window.webContents.mainFrame && event.senderFrame?.url === indexUrl + '#companion';
      const overlayChannels = ['sidekick:snapshot', 'sidekick:show', 'sidekick:cancel', 'sidekick:companion-layout', 'sidekick:companion-hit', 'sidekick:companion-move', 'sidekick:companion-grab', 'sidekick:heartbeat'];
      if (!isPanel && !(isCompanion && overlayChannels.includes(channel))) throw new Error('Untrusted IPC sender.');
      if (channel.startsWith('sidekick:companion-') && !isCompanion) throw new Error('Only the companion can update its overlay.');
      const expected = ['sidekick:snapshot', 'sidekick:hide', 'sidekick:browser', 'sidekick:heartbeat'].includes(channel) ? 0 : 1;
      if (args.length !== expected) throw new Error('Invalid IPC arguments.');
      if (channel === 'sidekick:heartbeat') { rendererHeartbeat(event.sender); return; }
      try { return await handler(args[0]); }
      catch (error) { throw new Error(explain(error)); }
    });
  };
  handle('sidekick:snapshot', snapshot);
  handle('sidekick:heartbeat', () => {});
  handle('sidekick:hide', () => {
    clearTimeout(collapseTimer);
    if (window && runner?.active()) companion?.depart(window.getBounds());
    window?.hide();
    companion?.launcher(false);
  });
  handle('sidekick:companion-layout', value => {
    const region = z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().min(0).max(2000), height: z.number().min(0).max(2000) });
    companion?.regions(z.array(region).max(16).parse(value));
  });
  handle('sidekick:companion-hit', value => companion?.hit(z.boolean().parse(value)));
  handle('sidekick:companion-grab', value => {
    const offset = z.strictObject({ x: z.number().finite().min(0).max(64), y: z.number().finite().min(0).max(64) }).parse(value);
    return companion?.grabRelative(offset, () => show(db.recent().length ? 'task' : 'command')) ?? false;
  });
  handle('sidekick:companion-move', value => {
    const point = z.strictObject({ x: z.number().finite(), y: z.number().finite(), dragging: z.boolean().optional() }).parse(value);
    companion?.move(point.x, point.y, point.dragging);
  });
  handle('sidekick:launcher-position', value => {
    const x = z.number().finite().min(0).max(2000).parse(value);
    if (!window || surface !== 'command') return;
    const bounds = window.getBounds();
    try { window.setShape([{ x: 0, y: 32, width: bounds.width, height: Math.max(1, bounds.height - 32) },
      ...(db.settings().showCompanion ? [{ x: Math.round(Math.min(x, bounds.width - 32)), y: 0, width: 32, height: 32 }] : [])]); } catch { /* Transparent launchers are still compact on unsupported platforms. */ }
  });
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
    companion?.launcher(false);
  });
  handle('sidekick:run', value => {
    if (accountBusy) throw new Error('Finish or cancel the ChatGPT account action first.');
    const command = commandSchema.parse(value);
    const running = engine.run(command);
    clearTimeout(collapseTimer);
    if (db.settings().showCompanion) { window?.hide(); companion?.launcher(false); }
    layout('task');
    publish();
    return running;
  });
  handle('sidekick:settings', value => {
    const next = settingsSchema.parse(value);
    const current = db.settings();
    next.restingPosition = next.restingCorner === current.restingCorner ? current.restingPosition : null;
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
    if (next.restingCorner !== current.restingCorner) companion?.chooseDisplay(false);
    companion?.visibility();
    return next;
  });

  Menu.setApplicationMenu(null);
  let mainRestarts: number[] = [];
  const createMain = () => {
  window = new BrowserWindow({
    width: dimensions.command[0], height: dimensions.command[1], show: false, title: 'Rove',
    backgroundColor: '#00000000', transparent: true, frame: false, resizable: false, maximizable: false, autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const created = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); window?.hide(); companion?.launcher(false); }
  });
  window.on('hide', () => companion?.launcher(false));
  window.on('minimize', () => companion?.launcher(false));
  window.on('show', () => companion?.launcher(surface === 'command'));
  recoverRenderer(created, 'launcher', logs, () => { publish(); if (created.isVisible()) created.webContents.send('sidekick:summon'); }, () => created.destroy());
  created.once('closed', () => {
    if (quitting) return;
    lifecycleLog(logs, 'launcher-closed');
    mainRestarts = mainRestarts.filter(at => Date.now() - at < 60_000);
    if (mainRestarts.length >= 3) return;
    mainRestarts.push(Date.now());
    setTimeout(() => { if (!quitting) void createMain().loadFile(indexPath).catch(() => lifecycleLog(logs, 'launcher-recreate-failed')); }, 250);
  });
  window.once('ready-to-show', summon);
  return created;
  };
  const initialMain = createMain();
  restoreMain = () => {
    if (window && !window.isDestroyed()) { show(runner?.active() ? 'task' : 'command', true); return; }
    mainRestarts = [];
    void createMain().loadFile(indexPath).catch(() => lifecycleLog(logs, 'launcher-recreate-failed'));
  };
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Rove');
  tray.on('click', summon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Rove', click: summon },
    { label: 'Open workspace', click: () => show('workspace', true) },
    { label: 'Bring companion back', click: () => {
      db.save({ ...db.settings(), showCompanion: true, restingPosition: null });
      companionRestarts = [];
      if (!companion || companion.window.isDestroyed()) void createCompanion().catch(() => lifecycleLog(logs, 'companion-recreate-failed'));
      else { companion.chooseDisplay(false); companion.launcher(false); }
      publish();
    } },
    { label: 'Quit Rove', click: () => app.quit() },
  ]));
  const configured = db.settings().shortcut;
  try { register(configured); registered = configured; }
  catch (error) { shortcutWarning = explain(error); }
  let companionRestarts: number[] = [];
  const createCompanion = async () => {
  companion = new DesktopCompanion(join(__dirname, 'preload.cjs'), () => db.settings(), position => {
    db.save({ ...db.settings(), restingPosition: position });
  }, publish, primaryButtonReader(helper('pointer.ps1')));
  companion.onActivate(() => show(db.recent().length ? 'task' : 'command'));
  companion.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  companion.window.webContents.on('will-navigate', event => event.preventDefault());
  companion.window.webContents.on('will-attach-webview', event => event.preventDefault());
  const created = companion;
  recoverRenderer(created.window, 'companion', logs, () => { publish(); created.visibility(); }, () => created.window.destroy());
  created.window.once('closed', () => {
    if (quitting) return;
    lifecycleLog(logs, 'companion-closed');
    companionRestarts = companionRestarts.filter(at => Date.now() - at < 60_000);
    if (companionRestarts.length >= 3) { show('command'); return; }
    companionRestarts.push(Date.now());
    setTimeout(() => { if (!quitting) void createCompanion().catch(() => { lifecycleLog(logs, 'companion-recreate-failed'); show('command'); }); }, 250);
  });
  await companion.window.loadFile(indexPath, { hash: 'companion' });
  companion.launcher(Boolean(window?.isVisible() && surface === 'command'));
  publish();
  };
  await createCompanion();
  await initialMain.loadFile(indexPath);
  if (chatgpt.status().sharing) void chatgpt.refreshModels();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', summon);
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    clearTimeout(collapseTimer);
    cancelSignIn();
    companion?.destroy();
    if (!browser) return;
    event.preventDefault();
    const active = runner?.active();
    if (active) runner?.cancel(active.id);
    desktopWorker?.close();
    const timeout = setTimeout(() => app.quit(), 3000);
    void browser.close().catch(() => {}).finally(() => { clearTimeout(timeout); app.quit(); });
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
  // Tray residency and window recovery must survive losing every renderer/window.
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  void app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Rove could not start', explain(error));
    app.quit();
  });
}
