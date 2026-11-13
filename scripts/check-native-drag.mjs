// Exercises the real Electron main-process drag loop without moving the system pointer.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { _electron } from 'playwright';

const cache = resolve('node_modules/.cache');
await mkdir(cache, { recursive: true });
const scratch = await mkdtemp(join(cache, 'sidekick-native-drag-'));
let app;
try {
  const entry = join(scratch, 'fixture.cjs');
  await build({ stdin: { resolveDir: resolve('.'), contents: `
    import {app,screen} from 'electron';
    import {DesktopCompanion} from './src/desktop-companion.ts';
    import {defaults} from './src/contracts.ts';
    app.whenReady().then(async()=>{
      globalThis.pointer={x:0,y:0};globalThis.down=false;globalThis.clicks=0;globalThis.position=null;
      screen.getCursorScreenPoint=()=>globalThis.pointer;
      globalThis.creature=new DesktopCompanion(${JSON.stringify(resolve('dist/preload.cjs'))},()=>defaults,
        value=>{globalThis.position=value;},()=>{},()=>globalThis.down);
      globalThis.creature.onActivate(()=>globalThis.clicks++);
      await globalThis.creature.window.loadURL('data:text/html,<body style="background:transparent"></body>');
      globalThis.ready=true;
    });` }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'], target: 'node24' });
  app = await _electron.launch({ args: [entry, '--user-data-dir=' + join(scratch, 'profile')], cwd: resolve('.') });
  for (let i = 0; i < 80 && !await app.evaluate(() => globalThis.ready); i++) await new Promise(r => setTimeout(r, 50));
  const state = () => app.evaluate(() => globalThis.creature.snapshot());
  const base = await app.evaluate(() => {
    const s = globalThis.creature.snapshot(), b = globalThis.creature.window.getBounds();
    return { x: b.x - s.viewX, y: b.y - s.viewY };
  });
  const setPointer = async (x, y, down) => {
    await app.evaluate((_electron, p) => { globalThis.pointer = { x: p.x, y: p.y }; globalThis.down = p.down; }, { x: base.x + x, y: base.y + y, down });
    await new Promise(r => setTimeout(r, 70));
  };
  const grabAt = from => app.evaluate((_electron, value) => {
    globalThis.down = true;
    globalThis.pointer = { x: value.base.x + value.from.x + 24, y: value.base.y + value.from.y + 30 };
    return globalThis.creature.grabRelative({ x: 24, y: 30 }, () => globalThis.clicks++);
  }, { from, base });
  for (const fraction of [.12, .8]) {
    const from = await state();
    const grabbed = await grabAt(from);
    assert.equal(grabbed, true);
    const x = Math.round(from.areaWidth * fraction), y = Math.round(from.areaHeight * .4);
    await setPointer(x + 24, y + 30, true);
    let current = await state();
    assert.equal(current.dragging, true);
    assert.equal(current.x, x);
    assert.equal(current.y, y);
    // Reshaping and disabling renderer hit regions must not terminate an OS-level drag.
    await app.evaluate(() => globalThis.creature.regions([]));
    await setPointer(x + 50, y + 10, true);
    current = await state();
    assert.equal(current.x, x + 26);
    assert.equal(current.y, y - 20);
    await setPointer(x + 50, y + 10, false);
    assert.equal((await state()).tucked, false, 'drop in desktop remains out');
    const free = await state();
    assert.equal(await grabAt(free), true);
    const dockX = Math.round(from.areaWidth * (1 - fraction)) - 64;
    await setPointer(dockX + 24, from.areaHeight - 8, true);
    await setPointer(dockX + 24, from.areaHeight - 8, false);
    const dock = await state();
    assert.equal(dock.x, dockX, 'release position chooses the new taskbar location');
    assert.equal(dock.y, from.areaHeight - 40);
    assert.equal(dock.tucked, true);
    assert.equal(dock.hovered, false);
    assert.equal(dock.dragging, false);
  }
  await new Promise(r => setTimeout(r, 250));
  // Regression: no pointerdown IPC, no renderer and no DOM pointer capture at all.
  // Only a physical button transition over the tucked head starts the gesture.
  let head = await state();
  await setPointer(head.x + 24, head.y + 30, false);
  await new Promise(r => setTimeout(r, 200));
  head = await state();
  const press = { x: head.x + 24, y: head.y + 30 };
  await setPointer(press.x, press.y, true);
  const held = await state();
  const offset = { x: press.x - held.x, y: press.y - held.y };
  await setPointer(160 + offset.x, 180 + offset.y, true);
  assert.equal((await state()).x, 160);
  assert.equal((await state()).y, 180);
  assert.equal((await state()).dragging, true, 'tucked head starts native drag without a renderer mouse-down');
  await setPointer(160 + offset.x, 180 + offset.y, false);
  assert.equal((await state()).tucked, false);
  head = await state();
  await setPointer(head.x + 24, head.y + 30, false);
  await setPointer(head.x + 24, head.y + 30, true);
  await setPointer(900 + 24, head.areaHeight - 8, true);
  await setPointer(900 + 24, head.areaHeight - 8, false);
  assert.equal((await state()).x, 900);
  assert.equal((await state()).tucked, true, 'physical release chooses the other taskbar position');
  // Dragging another application across the sprite must never start a companion drag.
  await setPointer(10, 10, true);
  head = await state();
  await setPointer(head.x + 24, head.y + 30, true);
  assert.equal((await state()).dragging, false);
  await setPointer(10, 10, false);
  await new Promise(r => setTimeout(r, 250));
  const saved = await app.evaluate(() => ({ position: globalThis.position, clicks: globalThis.clicks }));
  assert.equal(saved.position.y, 1);
  assert.equal(saved.clicks, 0, 'dragging never opens the task window');
  console.log('Native Electron drag passed: tucked-head press without renderer events, pull out, free drop, redock at release, capture loss, and unrelated mouse-drag exclusion.');
} finally {
  await app?.evaluate(() => globalThis.creature?.destroy()).catch(() => {});
  await app?.close();
  assert.ok(scratch.startsWith(cache + sep));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
