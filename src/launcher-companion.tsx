import { useEffect, useRef, useState } from 'react';
import type { Settings } from './contracts.ts';
import { Companion } from './companion.tsx';

export function LauncherCompanion({ command, settings }: { command: string; settings: Settings }) {
  const rail = useRef<HTMLDivElement>(null);
  const x = useRef(38);
  const typedAt = useRef(-10000);
  const [pose, setPose] = useState({ x: 38, walking: false, facing: 1 });
  const [warp, setWarp] = useState(0);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animated = settings.animateCompanion && !settings.quietMode && !reduced;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (command) typedAt.current = performance.now(); }, [command]);
  useEffect(() => {
    const report = () => { void window.sidekick.launcherPosition(Math.round(x.current)).catch(() => {}); };
    report();
    return window.sidekick.onSummon(() => { report(); setWarp(value => value + 1); });
  }, []);
  useEffect(() => {
    void window.sidekick.launcherPosition(pose.x).catch(() => {});
  }, [pose.x]);
  useEffect(() => {
    if (!animated) { setPose(previous => ({ ...previous, walking: false })); return; }
    let frame = 0, last = performance.now(), target = x.current, decideAt = 0, paintedAt = 0;
    const tick = (now: number) => {
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      const typing = !document.hidden && now - typedAt.current < 2200;
      const limit = Math.max(40, (rail.current?.clientWidth ?? 500) - 44);
      if (typing && now >= decideAt) {
        target = Math.max(12, Math.min(limit, x.current + (Math.random() < .5 ? -1 : 1) * (45 + Math.random() * 85)));
        decideAt = now + 1500 + Math.random() * 1800;
      }
      const distance = target - x.current;
      const walking = typing && Math.abs(distance) > 1;
      if (walking) x.current += Math.sign(distance) * Math.min(Math.abs(distance), dt * 35);
      if (now - paintedAt >= 33) {
        setPose(previous => {
          const next = { x: Math.round(x.current), walking, facing: walking ? Math.sign(distance) : previous.facing };
          return next.x === previous.x && next.walking === previous.walking && next.facing === previous.facing ? previous : next;
        });
        paintedAt = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animated]);
  return <div className="launcher-rail" ref={rail} aria-hidden="true">
    <div key={warp} className={`launcher-walker ${animated ? 'warp-in' : ''}`} data-walking={pose.walking} style={{ left: pose.x }}>
      <div style={{ transform: `scaleX(${pose.facing})` }}><Companion mood={pose.walking ? 'working' : 'idle'} animated={animated}/></div>
    </div>
  </div>;
}
