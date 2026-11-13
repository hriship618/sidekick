// Disposable-profile regression test. Does not move the user's pointer.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright';

const profile = await mkdtemp(join(tmpdir(), 'sidekick-overlay-'));
const scale = process.env.SIDEKICK_TEST_SCALE ?? '1.5';
let app;
async function native(title = 'Rove companion') {
  const data = await app.evaluate(({ BrowserWindow }, title) => {
    const w = BrowserWindow.getAllWindows().find(w => w.getTitle() === title);
    const h = w.getNativeWindowHandle();
    return { bounds: w.getBounds(), focusable: w.isFocusable(), focused: w.isFocused(),
      hwnd: (h.length === 8 ? h.readBigUInt64LE() : BigInt(h.readUInt32LE())).toString() };
  }, title);
  if (process.platform === 'win32') {
    const definition = 'using System; using System.Runtime.InteropServices; public class HitTest {' +
      '[DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h,int n);' +
      '[DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r);' +
      '[DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d);' +
      '[DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y);' +
      '[DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h); }';
    const script = `$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition '${definition}'
$h=[IntPtr][long]${data.hwnd}
$r=[HitTest]::CreateRectRgn(0,0,0,0)
$kind=[HitTest]::GetWindowRgn($h,$r)
@{ transparent=(([HitTest]::GetWindowLong($h,-20) -band 32) -ne 0); regionKind=$kind; emptyCorner=[HitTest]::PtInRegion($r,0,0) } | ConvertTo-Json -Compress
[void][HitTest]::DeleteObject($r)`;
    Object.assign(data, JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true })));
  }
  return data;
}
try {
  app = await _electron.launch({ args: ['.', '--user-data-dir=' + profile, '--force-device-scale-factor=' + scale], cwd: resolve('.'), timeout: 25000 });
  for (let i = 0; i < 80 && app.windows().length < 2; i++) await new Promise(r => setTimeout(r, 100));
  const overlay = app.windows().find(w => w.url().endsWith('#companion'));
  const panel = app.windows().find(w => !w.url().endsWith('#companion'));
  await overlay.locator('[data-creature]').waitFor();
  await panel.locator('input[aria-label=Command]').waitFor();
  await panel.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Rove companion').isVisible()), false, 'corner creature warps away while launcher is open');
  const launcherBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() !== 'Rove companion').getBounds());
  assert.ok(launcherBounds.height <= 129 && launcherBounds.width <= 541, 'compact launcher bounds');
  const mini = panel.locator('.launcher-walker');
  const initialX = await mini.evaluate(element => parseFloat(element.style.left));
  await panel.locator('input[aria-label=Command]').pressSequentially('a little typing', { delay: 70 });
  await panel.waitForTimeout(300);
  assert.notEqual(await mini.evaluate(element => parseFloat(element.style.left)), initialX, 'miniature walks while typing');
  const geometry = await panel.evaluate(() => ({ scroll: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    svg: document.querySelector('.launcher-walker svg').getBoundingClientRect().width,
    focus: document.activeElement?.getAttribute('aria-label') }));
  if (process.env.SIDEKICK_OVERLAY_SCREENSHOTS) await panel.screenshot({ path: join(process.env.SIDEKICK_OVERLAY_SCREENSHOTS, 'compact-launcher.png'), omitBackground: true });
  assert.equal(geometry.scroll, false, JSON.stringify(await panel.evaluate(() => ({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight, rects:[...document.querySelectorAll('.app,.command-surface,.command-field,.command-footer,.launcher-rail')].map(e=>({name:e.className,rect:e.getBoundingClientRect().toJSON()}))}))));
  assert.equal(geometry.svg, 32);
  assert.equal(geometry.focus, 'Command');
  if (process.platform === 'win32') assert.equal((await native('Rove')).emptyCorner, false, 'transparent launcher rail passes native clicks outside miniature');
  await panel.emulateMedia({ reducedMotion: 'reduce' });
  await panel.waitForTimeout(50);
  const stillX = await mini.evaluate(element => parseFloat(element.style.left));
  await panel.locator('input[aria-label=Command]').pressSequentially(' more', { delay: 50 });
  await panel.waitForTimeout(250);
  assert.equal(await mini.evaluate(element => parseFloat(element.style.left)), stillX, 'reduced motion disables wandering');
  await panel.emulateMedia({ reducedMotion: 'no-preference' });
  if (process.env.SIDEKICK_OVERLAY_SCREENSHOTS) await panel.screenshot({ path: join(process.env.SIDEKICK_OVERLAY_SCREENSHOTS, 'compact-launcher.png'), omitBackground: true });
  await panel.evaluate(() => window.sidekick.hide());
  // Control only pointer observations. Window bounds, hit regions and styles remain native.
  await app.evaluate(({ screen }) => {
    globalThis.testCursor = { x: -30000, y: -30000 };
    screen.getCursorScreenPoint = () => globalThis.testCursor;
  });
  const state = () => overlay.evaluate(() => window.sidekick.snapshot());
  const cursor = async point => {
    await app.evaluate((_electron, point) => { globalThis.testCursor = point; }, point);
    await new Promise(r => setTimeout(r, 300));
  };
  await cursor({ x: -30000, y: -30000 });
  let s = await state(), n = await native();
  if (process.env.SIDEKICK_OVERLAY_SCREENSHOTS) await overlay.screenshot({ path: join(process.env.SIDEKICK_OVERLAY_SCREENSHOTS, 'companion-tucked.png') });
  assert.equal(s.companion.tucked, true);
  assert.ok(n.bounds.width <= 381 && n.bounds.height <= 201, 'compact host allows one DIP of native rounding');
  assert.equal(n.focusable, false);
  if (process.platform === 'win32') {
    assert.ok(n.regionKind > 1, 'native shape bounds all input to visible regions');
    assert.equal(n.emptyCorner, false, 'native shape excludes invisible corners');
  }
  const origin = { x: n.bounds.x - s.companion.viewX, y: n.bounds.y - s.companion.viewY };
  const screenPoint = (x, y) => ({ x: origin.x + x, y: origin.y + y });
  await cursor(screenPoint(s.companion.x + 24, s.companion.y + 32));
  s = await state();
  assert.equal(s.companion.tucked, true, 'hover leaves body tucked');
  assert.equal(s.companion.hovered, true);
  assert.equal(s.companion.y, s.companion.areaHeight - 44, 'hover gently lifts head');
  if (process.env.SIDEKICK_OVERLAY_SCREENSHOTS) await overlay.screenshot({ path: join(process.env.SIDEKICK_OVERLAY_SCREENSHOTS, 'companion-hover.png') });
  await cursor(screenPoint(s.companion.x + 24, s.companion.y + 32));
  n = await native();
  if (process.platform === 'win32') assert.equal(n.transparent, false, 'body accepts clicks');
  await cursor(screenPoint(s.companion.x - 80, s.companion.y + 20));
  n = await native();
  if (process.platform === 'win32') assert.equal(n.emptyCorner, false, 'transparent space is outside the native input shape');
  s = await state();
  assert.equal(s.companion.tucked, true, 'leaving tucks back');
  assert.equal(s.companion.hovered, false);
  await new Promise(r => setTimeout(r, 250));
  s = await state();
  assert.equal(s.companion.y, s.companion.areaHeight - 40);
  assert.ok(n.bounds.y + n.bounds.height <= origin.y + s.companion.areaHeight, 'host never covers taskbar');
  await overlay.evaluate(() => window.sidekick.companionLayout([]));
  n = await native();
  if (process.platform === 'win32') assert.equal(n.transparent, true, 'empty layout fails closed');
  await overlay.evaluate(() => window.sidekick.show('command'));
  const before = (await state()).companion;
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() !== 'Rove companion').isFocused()), true);
  await app.evaluate(({ shell }) => { shell.openExternal = async () => { await new Promise(r => setTimeout(r, 1500)); }; });
  await panel.locator('input[aria-label=Command]').fill('Open YouTube');
  await panel.locator('input[aria-label=Command]').press('Enter');
  await new Promise(r => setTimeout(r, 150));
  s = await state();
  assert.ok(s.active, 'actual dispatch remains in flight');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() !== 'Rove companion').isVisible()), false, 'launcher immediately yields to companion');
  assert.equal(await overlay.locator('.companion-bubble, .floating-cancel').count(), 0, 'working remains quiet until hover');
  assert.equal(await overlay.locator('.companion.working').count(), 1);
  assert.equal(s.companion.x, before.x, 'task does not relocate companion');
  assert.equal(s.companion.y, before.y);
  await cursor(screenPoint(s.companion.x + 24, s.companion.y + 32));
  await overlay.locator('.companion-bubble').waitFor();
  await cursor({ x: -30000, y: -30000 });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await overlay.locator('.companion-bubble').count(), 0);
  await new Promise(r => setTimeout(r, 700));
  s = await state();
  assert.equal(s.runs[0].status, 'completed');
  n = await native();
  if (process.platform === 'win32') assert.equal(n.emptyCorner, false, 'background execution keeps transparent space outside the input shape');
  await new Promise(r => setTimeout(r, 1000));
  n = await native();
  assert.ok(n.bounds.width <= 381 && n.bounds.height <= 201, 'travel releases monitor-sized visual host');
  assert.equal(n.focused, false);
  const beforeDrag = (await state()).companion;
  const box = await overlay.locator('[data-creature]').boundingBox();
  await overlay.mouse.move(box.x + 24, box.y + 32);
  await overlay.mouse.down();
  await panel.waitForTimeout(60);
  await overlay.mouse.move(box.x + 4, box.y - 28, { steps: 5 });
  await overlay.mouse.up();
  await new Promise(r => setTimeout(r, 350));
  const afterDrag = (await state()).companion;
  assert.ok(afterDrag.y < beforeDrag.y - 20, 'only a drag pulls the body out');
  const pulledBox = await overlay.locator('[data-creature]').boundingBox();
  await overlay.mouse.move(pulledBox.x + 24, pulledBox.y + 32);
  await overlay.mouse.down();
  await panel.waitForTimeout(60);
  const overlayBounds = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Rove companion').getBounds());
  const dropCursor = screenPoint(afterDrag.x + 24, afterDrag.areaHeight - 8);
  await app.evaluate((_electron, point) => { globalThis.testCursor = point; }, dropCursor);
  await overlay.mouse.move(dropCursor.x - overlayBounds.x, dropCursor.y - overlayBounds.y);
  await overlay.mouse.up();
  await panel.waitForTimeout(400);
  assert.equal((await state()).companion.tucked, true, 'real pointer-up restores the dock');
  assert.equal(await overlay.locator('.companion-bubble').count(), 0, 'real pointer-up clears details');
  for (let cycle = 0; cycle < 3; cycle++) {
    const current = (await state()).companion;
    await cursor(screenPoint(current.x + 24, current.areaHeight - 8));
    await overlay.evaluate(async point => {
      await window.sidekick.moveCompanion({ ...point, dragging: true });
      await window.sidekick.moveCompanion({ ...point, dragging: false });
    }, { x: current.x, y: current.areaHeight - 40 });
    const dock = (await state()).companion;
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await state()).companion.hovered, false, 'drop suppresses stale hover until pointer leaves');
    assert.equal((await state()).companion.tucked, true);
    assert.equal(await overlay.locator('.companion-bubble').count(), 0, 'redocking clears speech bubble');
    assert.equal(await overlay.locator('.companion.animated').count(), 1, 'redocking preserves animation');
    assert.equal(await overlay.locator('.companion.idle .eyes').evaluate(element => getComputedStyle(element).animationName), 'eyes', 'completion returns to idle blinking');
    await cursor({ x: -30000, y: -30000 });
    await cursor(screenPoint(dock.x + 24, dock.y + 32));
    await overlay.locator('.companion-bubble').waitFor();
    await cursor({ x: -30000, y: -30000 });
    await panel.waitForTimeout(250);
  }
  const rest = (await state()).companion;
  await overlay.evaluate(() => window.sidekick.show('command'));
  const afterSummon = (await state()).companion;
  assert.equal(afterSummon.x, rest.x, 'summon preserves dragged position');
  assert.equal(afterSummon.y, rest.y);
  await overlay.evaluate(() => window.sidekick.show('workspace'));
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  const desktopToggle = panel.getByRole('checkbox', { name: 'Desktop access', exact: true });
  assert.equal(await desktopToggle.isChecked(), true);
  await desktopToggle.uncheck();
  await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
  await panel.getByText('Settings saved', { exact: true }).waitFor();
  const savedSettings = await state();
  assert.equal(savedSettings.settings.desktopAccess, false);
  assert.equal(savedSettings.companion.x, rest.x, 'settings do not relocate companion');
  assert.equal(savedSettings.companion.y, rest.y);
  await panel.evaluate(async () => {
    const state = await window.sidekick.snapshot();
    await window.sidekick.saveSettings({ ...state.settings, showCompanion: false });
    await window.sidekick.show('command');
  });
  assert.equal(await panel.locator('.launcher-walker').count(), 0, 'hidden companion also hides miniature');
  const plain = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.getTitle() !== 'Rove companion').getBounds());
  assert.ok(plain.height <= 97, 'hidden companion removes unused rail');
  console.log('Overlay passed at scale ' + scale + ': compact launcher, walking miniature, reduced motion, native click-through, repeated redocking, bubble dismissal, restored blinking, focus and task execution.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
