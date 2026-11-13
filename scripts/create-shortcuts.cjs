// Run with Electron: use its Windows shortcut API without shell command construction.
const { app, shell } = require('electron');
const { join, resolve } = require('node:path');
const { access, mkdir } = require('node:fs/promises');

app.whenReady().then(async () => {
  if (process.platform !== 'win32') throw new Error('Rove shortcuts require Windows.');
  const root = resolve(__dirname, '..');
  const icon = join(root, 'resources', 'rove.ico');
  await Promise.all([access(icon), access(join(root, 'dist', 'main.cjs'))]);
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  await mkdir(programs, { recursive: true });
  const options = { target: process.execPath, args: `"${root}"`, cwd: root,
    icon, iconIndex: 0, appUserModelId: 'io.rove.desktop',
    description: 'Open Rove — Windows desktop assistant. Uses this local development checkout.' };
  for (const directory of [app.getPath('desktop'), programs]) {
    const path = join(directory, 'Rove.lnk');
    if (!shell.writeShortcutLink(path, 'create', options)) throw new Error('Windows could not create the Rove shortcut.');
    const saved = shell.readShortcutLink(path);
    if (saved.target.toLowerCase() !== options.target.toLowerCase() || saved.args !== options.args || saved.appUserModelId !== options.appUserModelId)
      throw new Error('The Rove shortcut did not retain its launch settings.');
    console.log('Created and verified: ' + path);
  }
  app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
