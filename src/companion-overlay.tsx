import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Companion, type Mood } from './companion.tsx';
import type { Snapshot } from './contracts.ts';

const api = window.sidekick;
type Drag = { x: number; y: number; startX: number; startY: number; moved: boolean; ended?: boolean; last?: { x: number; y: number } };
export function CompanionOverlay({ snapshot }: { snapshot: Snapshot }) {
  const { settings, active, companion, runs } = snapshot;
  const latest = runs[0];
  const [point, setPoint] = useState({ x: companion.x, y: companion.y });
  const [details, setDetails] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [error, setError] = useState('');
  const [celebrating, setCelebrating] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const meaningfulPhase = useRef({ id: '', text: 'On it…' });
  const lastHit = useRef(false);
  const areaWidth = companion.areaWidth ?? innerWidth;
  const areaHeight = companion.areaHeight ?? innerHeight;
  const drag = useRef<Drag | null>(null);
  const dragMode = useRef<'pending' | 'native' | 'renderer'>('renderer');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = settings.animateCompanion && !settings.quietMode && !reduced;
  const mood: Mood = active?.question ? 'waiting' : active ? 'working'
    : latest?.status === 'completed' && celebrating ? 'completed' : latest?.status === 'failed' || latest?.status === 'interrupted' ? 'failed' : latest?.status === 'waiting' ? 'waiting' : 'idle';
  if (active && meaningfulPhase.current.id !== active.id) meaningfulPhase.current = { id: active.id, text: 'On it…' };
  if (active?.phase && active.phase !== 'Planning the next step') meaningfulPhase.current.text = active.phase;
  const text = error || (active?.question ? active.question.kind === 'local' ? 'Your input is needed' : active.question.text
    : active?.cancelling ? 'Stopping…' : active ? meaningfulPhase.current.text
      : latest?.status === 'failed' || latest?.status === 'interrupted' ? latest.message
        : latest?.status === 'waiting' ? latest.message : latest?.message ?? '');
  const persistent = Boolean(active?.question || latest?.status === 'failed' || latest?.status === 'interrupted' || latest?.status === 'waiting');
  const completed = latest?.steps.filter(step => step.status === 'completed').length ?? 0;
  const displayText = !active && latest?.status === 'failed' && completed ? `${text} (${completed} actions completed.)` : text;

  function perform(action: () => Promise<void>) {
    void action().catch(error => setError(error instanceof Error ? error.message : 'Could not update Rove.'));
  }
  useEffect(() => {
    if (latest?.status !== 'completed' || !latest.finishedAt || Date.now() - new Date(latest.finishedAt).getTime() > 2000) { setCelebrating(false); return; }
    setCelebrating(true);
    const timer = setTimeout(() => setCelebrating(false), 1200);
    return () => clearTimeout(timer);
  }, [latest?.id, latest?.status]);

  useEffect(() => {
    let frame = 0;
    let next = 0;
    if (companion.moving && motion) {
      setPoint({ x: companion.fromX, y: companion.fromY });
      frame = requestAnimationFrame(() => { next = requestAnimationFrame(() => setPoint({ x: companion.x, y: companion.y })); });
    } else setPoint({ x: companion.x, y: companion.y });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(next); };
  }, [companion.sequence, motion]);

  useEffect(() => {
    if (!companion.hovered) { setDetails(false); return; }
    const timer = setTimeout(() => setDetails(true), 240);
    return () => clearTimeout(timer);
  }, [companion.hovered, companion.dockRevision]);
  useEffect(() => {
    if (!companion.dockRevision) return;
    drag.current = null;
    setDragging(false);
    setDetails(false);
  }, [companion.dockRevision]);

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const showBubble = Boolean(text && ((details && companion.hovered) || dragging || companion.dragging));
  const bubbleX = point.x > 310 ? Math.max(8, point.x - 306) : Math.min(areaWidth - 302, point.x + 72);
  const bubbleY = Math.max(8, Math.min(point.y - 24, areaHeight - 128));

  useLayoutEffect(() => {
    if (companion.moving) return;
    const frame = requestAnimationFrame(() => {
      if (!root.current) return;
      const creature = root.current.querySelector('[data-creature]')!.getBoundingClientRect();
      const pixels = [
        [16, 16, 32, 4], [12, 20, 40, 8], [4, 28, 56, 16], [12, 44, 40, 4], [16, 48, 12, 8], [36, 48, 12, 8],
      ].map(([x, y, width, height]) => ({ x: creature.x + x, y: creature.y + y, width, height }));
      const controls = [...root.current.querySelectorAll('[data-hit]')].map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      perform(() => api.companionLayout([...pixels, ...controls]));
    });
    return () => cancelAnimationFrame(frame);
  }, [point.x, point.y, showBubble, text, companion.moving, companion.dragging, companion.viewX, companion.viewY, Boolean(active), persistent]);

  function down(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || companion.moving) return;
    event.preventDefault();
    const current: Drag = { x: point.x, y: point.y, startX: event.screenX, startY: event.screenY, moved: false };
    drag.current = current;
    dragMode.current = 'pending';
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    void api.grabCompanion({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }).then(native => {
      if (drag.current !== current) return;
      dragMode.current = native ? 'native' : 'renderer';
      if (native) { drag.current = null; setDragging(false); }
      else if (current.ended) finish(current);
    }).catch(() => { dragMode.current = 'renderer'; if (current.ended) finish(current); });
  }
  function finish(current: Drag) {
    drag.current = null; setDragging(false); setDetails(false);
    if (current.moved) perform(() => api.moveCompanion({ ...(current.last ?? point), dragging: false }));
    else perform(() => api.show(latest ? 'task' : 'command'));
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || dragMode.current !== 'renderer') return;
    const dx = event.screenX - current.startX;
    const dy = event.screenY - current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    if (current.moved) {
      setDragging(true);
      const next = { x: Math.round(Math.max(0, Math.min(current.x + dx, areaWidth - 64))),
        y: Math.round(Math.max(0, Math.min(current.y + dy, areaHeight - 40))) };
      setPoint(next);
      current.last = next;
      perform(() => api.moveCompanion({ ...next, dragging: true }));
    }
  }
  function up(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (current && dragMode.current === 'pending') { current.ended = true; return; }
    if (current) finish(current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div ref={root} className="desktop-overlay" style={{ width: areaWidth, height: areaHeight,
    left: -(companion.viewX ?? 0), top: -(companion.viewY ?? 0) }} onMouseMove={event => {
    const interactive = event.target instanceof Element && Boolean(event.target.closest('button'));
    if (interactive !== lastHit.current) {
      lastHit.current = interactive;
      void api.companionHit(interactive);
    }
  }}>
    <button data-creature className={`desktop-creature ${companion.moving && motion ? 'travelling' : ''}`}
      style={{ left: point.x, top: point.y }} title="Open Rove task. Drag to move."
      aria-label="Open Rove task" onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onLostPointerCapture={() => {
        if (dragMode.current !== 'renderer') return;
        const current = drag.current; drag.current = null; setDragging(false); setDetails(false);
        if (current?.moved) perform(() => api.moveCompanion({ ...(current.last ?? point), dragging: false }));
      }} onPointerCancel={() => {
        if (dragMode.current !== 'renderer') return;
        const current = drag.current; drag.current = null; setDragging(false); setDetails(false);
        if (current?.moved) perform(() => api.moveCompanion({ ...(current.last ?? point), dragging: false }));
      }}>
      <Companion mood={mood} animated={motion && visible}/>
    </button>
    {showBubble && !companion.moving && <aside className="companion-bubble" style={{ left: bubbleX, top: bubbleY }}>
      <button data-hit className="bubble-message" onClick={() => perform(() => api.show(latest ? 'task' : 'command'))}>
        <span>{displayText}</span><small>{active?.question ? 'Answer →' : persistent ? 'Review task →' : active ? 'View task →' : 'Details →'}</small>
      </button>
      {active && <button data-hit className="bubble-cancel" disabled={active.cancelling}
        onClick={() => perform(() => api.cancel(active.id))}>{active.cancelling ? 'Stopping…' : 'Cancel task'}</button>}
    </aside>}
  </div>;
}
