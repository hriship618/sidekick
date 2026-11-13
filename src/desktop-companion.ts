import { BrowserWindow, screen, systemPreferences, type Rectangle, type Display } from 'electron';
import type { CompanionState, Settings } from './contracts.ts';
import { clampPosition, creatureSize, panelNearCompanion, restingPosition, companionViewport, contains, dockedPosition, taskbarEdge, nearDock, creatureHit } from './companion-geometry.ts';
import { CompanionDrag } from './companion-drag.ts';
import { primaryButtonReader, type PrimaryReader } from './windows-pointer.ts';
import { dirname, join } from 'node:path';

export class DesktopCompanion {
  readonly window: BrowserWindow;
  private readonly settings: () => Settings;
  private readonly persist: (position: Settings['restingPosition']) => void;
  private readonly publish: () => void;
  private displayId = '';
  private area = { x: 0, y: 0, width: 800, height: 600 };
  private state: CompanionState = { x: 0, y: 0, fromX: 0, fromY: 0, sequence: 0, moving: false };
  private motionTimer?: ReturnType<typeof setTimeout>;
  private hoverAnimation?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pointerTimer: ReturnType<typeof setInterval>;
  private regionsLocal: Rectangle[] = [];
  private ignoring = true;
  private docked = true;
  private edge: ReturnType<typeof taskbarEdge> = 'bottom';
  private leaveAt = 0;
  private hoverArmed = true;
  private launcherVisible = false;
  private readonly primaryDown?: PrimaryReader;
  private nativeDrag?: { gesture: CompanionDrag; click: () => void };
  private previousDown = false;
  private nativeShape = false;
  private activate: () => void = () => {};
  private stopped = false;
  private readonly displayChanged = () => this.chooseDisplay(false);

  constructor(preload: string, getSettings: () => Settings, persist: (position: Settings['restingPosition']) => void, publish: () => void, primaryDown = primaryButtonReader(join(dirname(preload), 'pointer.ps1'))) {
    this.primaryDown = primaryDown;
    this.settings = getSettings;
    this.persist = persist;
    this.publish = publish;
    this.window = new BrowserWindow({
      title: 'Rove companion', frame: false, transparent: true, backgroundColor: '#00000000',
      focusable: false, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false,
      hasShadow: false, show: false, alwaysOnTop: true,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.window.on('page-title-updated', event => event.preventDefault());
    this.window.once('closed', () => this.cleanup());
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.chooseDisplay(false);
    // Native pointer coordinates also arrive while the overlay is click-through.
    // Renderer hover events alone cannot reliably restore click-through on Windows.
    this.pointerTimer = setInterval(() => this.updatePointer(), 16);
    screen.on('display-metrics-changed', this.displayChanged);
    screen.on('display-removed', this.displayChanged);
    screen.on('display-added', this.displayChanged);
  }

  snapshot() { return this.state; }
  private usableArea(display: Display) {
    const b = display.bounds;
    let a = display.workArea;
    // Forced DPI on Windows can report workArea in physical pixels while bounds are DIP.
    if (process.platform === 'win32' && (a.width > b.width + 1 || a.height > b.height + 1)) {
      a = screen.screenToDipRect(null, a);
    }
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(1, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(1, Math.min(a.y + a.height, b.y + b.height) - y) };
  }
  private ignore(value: boolean) {
    if (value === this.ignoring) return;
    this.ignoring = value;
    this.window.setIgnoreMouseEvents(value, { forward: true });
  }
  private input(control: boolean) { this.ignore(this.nativeShape ? false : !control); }
  private fit() {
    const viewport = this.state.moving ? { x: 0, y: 0, width: this.area.width, height: this.area.height }
      : companionViewport(this.state, this.area);
    this.state = { ...this.state, viewX: viewport.x, viewY: viewport.y, areaWidth: this.area.width, areaHeight: this.area.height };
    // Reserve two DIP at desktop edges for Windows' physical-pixel rounding at fractional DPI.
    const bounds = { ...viewport, x: this.area.x + viewport.x, y: this.area.y + viewport.y,
      width: Math.max(1, Math.min(viewport.width, this.area.width - viewport.x - 2)),
      height: Math.max(1, Math.min(viewport.height, this.area.height - viewport.y - 2)) };
    const current = this.window.getBounds();
    if (Math.abs(current.x - bounds.x) <= 1 && Math.abs(current.y - bounds.y) <= 1 && Math.abs(current.width - bounds.width) <= 1 && Math.abs(current.height - bounds.height) <= 1) return;
    this.ignore(!this.state.dragging);
    this.nativeShape = false;
    this.regionsLocal = [];
    try { this.window.setShape([]); } catch { /* Always click-through during layout. */ }
    this.window.setBounds(bounds);
  }
  private updatePointer() {
    if (this.window.isDestroyed()) return;
    const down = this.primaryDown?.() ?? false;
    const pressed = down && !this.previousDown;
    this.previousDown = down;
    if (!this.window.isVisible() || this.state.moving) { this.ignore(true); return; }
    const cursor = screen.getCursorScreenPoint();
    const point = { x: cursor.x - this.area.x, y: cursor.y - this.area.y };
    // A tucked transparent/no-activate window may never receive a renderer pointerdown.
    // Start from the physical press over a visible sprite pixel, independently of Chromium.
    if (!this.nativeDrag && pressed && contains(this.area, cursor) && creatureHit(point, this.state)) this.grab(cursor, this.activate);
    if (this.nativeDrag) {
      const session = this.nativeDrag;
      const target = session.gesture.sample(cursor);
      if (!down) {
        this.nativeDrag = undefined;
        if (session.gesture.moved) this.move(target.x - this.area.x, target.y - this.area.y, false);
        else session.click();
      } else if (session.gesture.moved) {
        const point = clampPosition(target.x - this.area.x, target.y - this.area.y, { ...this.area, height: this.area.height + 24 });
        if (!this.state.dragging || point.x !== this.state.x || point.y !== this.state.y) this.move(point.x, point.y, true);
      }
      return;
    }
    const local = { x: point.x - (this.state.viewX ?? 0), y: point.y - (this.state.viewY ?? 0) };
    const insideWork = contains(this.area, cursor);
    const control = insideWork && this.regionsLocal.some(rect => contains(rect, local));
    if (this.state.dragging) { this.ignore(false); return; }
    if (this.docked) {
      const popped = dockedPosition(this.state, this.area, this.edge, false);
      const tucked = dockedPosition(this.state, this.area, this.edge, true);
      const corridor = { x: Math.min(popped.x, tucked.x), y: Math.min(popped.y, tucked.y),
        width: 64 + Math.abs(popped.x - tucked.x), height: 64 + Math.abs(popped.y - tucked.y) };
      const hovering = insideWork && (contains(corridor, point) || control);
      if (!this.hoverArmed) {
        if (!hovering) this.hoverArmed = true;
        this.input(control);
        return;
      }
      if (hovering) this.leaveAt = 0;
      else if (!this.leaveAt) this.leaveAt = Date.now();
      if ((hovering && !this.state.hovered) || (!hovering && this.state.hovered && Date.now() - this.leaveAt > 240)) { this.hover(hovering); return; }
    } else if (Boolean(this.state.hovered) !== control) {
      this.state = { ...this.state, hovered: control };
      this.publish();
    }
    // Never make the entire transparent host interactive. Empty/stale layouts fail closed.
    this.input(control);
  }

  private hover(hovered: boolean) {
    clearInterval(this.hoverAnimation);
    const target = dockedPosition(this.state, this.area, this.edge, true);
    // A small head lift on hover; only an explicit drag pulls the creature out.
    if (hovered) {
      if (this.edge === 'bottom') target.y -= 4;
      if (this.edge === 'top') target.y += 4;
      if (this.edge === 'left') target.x += 4;
      if (this.edge === 'right') target.x -= 4;
    }
    const from = { x: this.state.x, y: this.state.y }, start = Date.now();
    this.state = { ...this.state, hovered };
    const animate = this.settings().animateCompanion && !this.settings().quietMode && !systemPreferences.getAnimationSettings().prefersReducedMotion;
    const frame = () => {
      const t = animate ? Math.min(1, (Date.now() - start) / 180) : 1;
      const eased = 1 - Math.pow(1 - t, 3);
      this.state = { ...this.state, x: Math.round(from.x + (target.x - from.x) * eased),
        y: Math.round(from.y + (target.y - from.y) * eased), sequence: this.state.sequence + 1 };
      this.fit();
      this.publish();
      if (t === 1) clearInterval(this.hoverAnimation);
    };
    this.hoverAnimation = setInterval(frame, 16);
    frame();
  }

  chooseDisplay(atCursor: boolean) {
    this.nativeDrag = undefined;
    clearTimeout(this.motionTimer);
    clearInterval(this.hoverAnimation);
    const display = screen.getAllDisplays().find(item => String(item.id) === (this.displayId || this.settings().restingPosition?.displayId)) ?? screen.getPrimaryDisplay();
    this.displayId = String(display.id);
    this.area = this.usableArea(display);
    this.edge = taskbarEdge(display.bounds, this.area);
    const saved = this.settings().restingPosition;
    this.docked = !saved || saved.displayId !== this.displayId || saved.y >= .98;
    const resting = restingPosition(this.settings(), this.displayId, this.area);
    const point = this.docked ? dockedPosition(resting, this.area, this.edge, true) : resting;
    this.state = { ...point, fromX: point.x, fromY: point.y, sequence: this.state.sequence + 1, moving: false, tucked: this.docked, hovered: false };
    this.fit();
    this.visibility();
    this.publish();
  }

  panel(width: number, height: number, atCursor: boolean) {
    return panelNearCompanion(this.state, this.area, Math.min(width, this.area.width - 16), Math.min(height, this.area.height - 16));
  }
  visibility() {
    if (this.window.isDestroyed()) return;
    if (this.settings().showCompanion && !this.launcherVisible) this.window.showInactive();
    else { this.ignore(true); this.window.hide(); }
  }
  launcher(visible: boolean) {
    if (visible && this.nativeDrag) { this.nativeDrag = undefined; this.move(this.state.x, this.state.y, false); }
    this.launcherVisible = visible; this.visibility();
  }
  grab(pointer: { x: number; y: number }, click: () => void) {
    if (this.nativeDrag) return true;
    if (!this.window.isVisible() || !this.primaryDown?.()) return false;
    if (!contains({ x: this.area.x + this.state.x, y: this.area.y + this.state.y, width: 64, height: 64 }, pointer)) return false;
    clearInterval(this.hoverAnimation);
    this.nativeDrag = { gesture: new CompanionDrag({ x: this.area.x + this.state.x, y: this.area.y + this.state.y }, pointer), click };
    return true;
  }
  onActivate(callback: () => void) { this.activate = callback; }
  grabRelative(offset: { x: number; y: number }, click: () => void) {
    return this.grab({ x: this.area.x + this.state.x + offset.x, y: this.area.y + this.state.y + offset.y }, click);
  }
  depart(_panel: Rectangle) { this.visibility(); }
  regions(regions: Rectangle[]) {
    if (this.state.moving || this.state.dragging) return;
    const bounds = this.window.getBounds();
    this.regionsLocal = regions.map(rect => {
      const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
      return { x, y, width: Math.min(bounds.width, Math.round(rect.x + rect.width)) - x,
        height: Math.min(bounds.height, Math.round(rect.y + rect.height)) - y };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    // A native shape provides synchronous hit testing between pointer polls.
    // Never pass [] to setShape: Electron treats it as restoring a rectangular window.
    try {
      this.window.setShape(this.regionsLocal.length ? this.regionsLocal : [{ x: 0, y: 0, width: 1, height: 1 }]);
      this.nativeShape = this.regionsLocal.length > 0;
    } catch { this.nativeShape = false; /* Pointer gating remains available. */ }
    this.updatePointer();
  }
  hit(_interactive: boolean) { this.updatePointer(); }
  move(x: number, y: number, dragging = false) {
    if (dragging && !this.state.dragging) {
      this.ignore(false);
      this.nativeShape = false;
      this.regionsLocal = [];
      try { this.window.setShape([]); } catch { /* The compact host retains pointer capture. */ }
    }
    if (!dragging && this.state.dragging) { this.ignore(true); this.nativeShape = false; }
    let point = clampPosition(x, y, { ...this.area, height: this.area.height + 24 });
    clearTimeout(this.motionTimer);
    clearInterval(this.hoverAnimation);
    this.docked = !dragging && nearDock(point, this.area, this.edge);
    if (this.docked) { point = dockedPosition(point, this.area, this.edge, true); this.hoverArmed = false; }
    this.state = { ...point, fromX: point.x, fromY: point.y, moving: false, dragging,
      tucked: this.docked, hovered: dragging, dockRevision: (this.state.dockRevision ?? 0) + (this.docked ? 1 : 0), sequence: this.state.sequence + 1 };
    this.fit();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist({
      displayId: this.displayId, x: point.x / Math.max(1, this.area.width - creatureSize),
      y: Math.min(1, point.y / Math.max(1, this.area.height - creatureSize)),
    }), 200);
    this.publish();
  }
  private cleanup() {
    if (this.stopped) return;
    this.stopped = true;
    this.primaryDown?.dispose?.();
    this.nativeDrag = undefined;
    clearTimeout(this.motionTimer);
    clearInterval(this.hoverAnimation);
    clearTimeout(this.saveTimer);
    clearInterval(this.pointerTimer);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    screen.removeListener('display-removed', this.displayChanged);
    screen.removeListener('display-added', this.displayChanged);
  }
  destroy() { this.cleanup(); if (!this.window.isDestroyed()) this.window.destroy(); }
}

