export type Mood = 'idle' | 'working' | 'waiting' | 'completed' | 'failed';

export function Companion({ mood, animated }: { mood: Mood; animated: boolean }) {
  const leaning = mood === 'waiting';
  return <svg className={`companion ${mood} ${animated ? 'animated' : ''}`} viewBox="0 0 16 16"
    shapeRendering="crispEdges" aria-hidden="true">
    {mood === 'completed' && <path className="sparkles" fill="#e0cfff" d="M2 4h1v1H2zm11-2h1v1h-1zm1 3h1v1h-1z"/>}
    <g className="sprite">
      <path fill="#8062cf" d="M1 8h2v3H1zm12 0h2v3h-2z"/>
      <path className="foot-left" fill="#8e70de" d="M4 12h3v2H4z"/>
      <path className="foot-right" fill="#8e70de" d="M9 12h3v2H9z"/>
      <path fill="#a78bfa" d={leaning
        ? 'M5 4h7v1h1v2h1v4h-1v1H3v-1H2V8h1V6h1V5h1z'
        : 'M4 4h8v1h1v2h1v4h-1v1H3v-1H2V7h1V5h1z'}/>
      <path fill="#c4afff" d={leaning ? 'M5 4h7v1H5z' : 'M4 4h8v1H4z'}/>
      <path fill="#9475e7" d="M3 11h10v1H3z"/>
      <g fill="#2a203b" transform={leaning ? 'translate(1 0)' : undefined}>
        <path className="eyes" d="M5 7h2v2H5zm4 0h2v2H9z"/>
        <path className="blink" d="M5 8h2v1H5zm4 0h2v1H9z"/>
        {mood === 'failed' && <path d="M5 6h1v1H5zm5 0h1v1h-1zM7 10h2v1H7z"/>}
        {mood === 'completed' && <path d="M7 9h2v2H7z"/>}
      </g>
    </g>
  </svg>;
}

