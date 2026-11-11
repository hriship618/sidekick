import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActiveRun, Run, Settings, SidekickApi, Snapshot, Surface } from './contracts.ts';
import { Companion, type Mood } from './companion.tsx';
import { errorText, SettingsPanel } from './settings.tsx';
import './style.css';

declare global { interface Window { sidekick: SidekickApi } }
const api = window.sidekick;
const statusLabels = { running: 'In progress', waiting: 'Setup needed', completed: 'Completed', failed: 'Needs attention', interrupted: 'Interrupted', cancelled: 'Cancelled' };
const taskTitles: Record<string, string> = { openLocal: 'Open a file or folder', openUrl: 'Open a link' };

function taskTitle(run: Run) {
  if (run.routine) return run.routine;
  return taskTitles[run.steps[0]?.tool] ?? 'Run command';
}
const stepLabels = { queued: 'Queued', running: 'In progress', completed: 'Dispatched', failed: 'Failed', skipped: 'Skipped' };
const paths = {
  bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  close: 'm6 6 12 12M18 6 6 18',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  history: 'M3 12a9 9 0 1 0 3-7m-3-2v5h5m4-1v5l3 2',
  settings: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4',
  terminal: 'm5 7 5 5-5 5m8 0h6',
};
type IconName = keyof typeof paths;
function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

function Titlebar({ surface, navigate, settings, hide }: { surface: Surface; navigate: (surface: Surface) => void; settings: () => void; hide: () => void }) {
  return <header className="titlebar">
    <div className="brand"><span className="brand-mark"><Icon name="bolt"/></span>Sidekick</div>
    <div className="title-actions">
      {surface !== 'workspace' && <button className="quiet workspace-button" onClick={() => navigate('workspace')}><Icon name="grid"/> Workspace</button>}
      {surface !== 'workspace' && <button className="quiet workspace-button" onClick={settings}><Icon name="settings"/> Settings</button>}
      <button className="quiet icon-button" onClick={hide} title="Hide Sidekick (Esc)" aria-label="Hide Sidekick"><Icon name="close"/></button>
    </div>
  </header>;
}

function CommandBar({ snapshot, command, change, run, input, busy, task }: {
  snapshot: Snapshot; command: string; change: (value: string) => void; run: (value: string) => void;
  input: React.RefObject<HTMLInputElement | null>; busy: boolean; task: () => void;
}) {
  const active = Boolean(snapshot.active);
  useEffect(() => { input.current?.focus(); }, [input]);

  function submit(event: FormEvent) {
    event.preventDefault();
    run(command);
  }

  return <main className="command-surface arrive">
    <form className="command-field" onSubmit={submit}>
      <span className="prompt"><Icon name="terminal"/></span>
      <input ref={input} aria-label="Command" placeholder="What would you like to do?" maxLength={4096}
        value={command} onChange={event => change(event.target.value)}/>
      <button className="primary run-button" disabled={busy || active || !command.trim()}>Run <span aria-hidden="true">↵</span></button>
    </form>
    {active ? <div className="command-empty"><span>A task is already in progress.</span><button className="secondary" onClick={task}>View task</button></div>
      : <p className="command-empty muted">{snapshot.settings.connectionMode === 'chatgpt'
        ? snapshot.chatgpt.sharing ? 'Using ChatGPT plan.' : 'Open Settings and continue with ChatGPT.'
        : snapshot.credentialSaved ? 'Using your OpenAI API key.' : 'Open Settings to connect your API key.'}</p>}
    <footer className="command-footer">
      <span><kbd>↵</kbd> Run <kbd>Esc</kbd> Hide</span>
      {snapshot.runs.length > 0 && !active && <button className="quiet last-task" onClick={task}>Last task</button>}
      {snapshot.settings.showCompanion && <Companion mood="idle" animated={snapshot.settings.animateCompanion}/>}
    </footer>
    {snapshot.shortcutWarning && <p className="notice" role="alert">{snapshot.shortcutWarning}</p>}
  </main>;
}

function Details({ run, element }: { run: Run; element?: React.RefObject<HTMLDetailsElement | null> }) {
  const started = new Date(run.createdAt);
  const elapsed = run.finishedAt ? Math.max(0, new Date(run.finishedAt).getTime() - started.getTime()) : undefined;
  return <details className="details" ref={element}>
    <summary>Execution details</summary>
    <div className="detail-body">
      <p className="detail-command"><code>{run.command}</code></p>
      <p className="muted">Started <time dateTime={run.createdAt}>{started.toLocaleString()}</time>
        {elapsed !== undefined && ` · ${(elapsed / 1000).toFixed(2)} s`}</p>
      <ol className="step-log">{run.steps.map((step, index) => <li key={index}>
        <div><strong>{step.label}</strong><small className={step.status}>{stepLabels[step.status]}</small></div>
        <code>{step.tool}</code>
        {(step.error || step.result) && <p>{step.error ?? step.result?.message}</p>}
      </li>)}</ol>
    </div>
  </details>;
}

function TaskCard({ run, active, settings, edit, next, setup, perform }: {
  run: Run; active: ActiveRun | null; settings: Settings; edit: () => void; next: () => void; setup: () => void;
  perform: (action: () => Promise<void>) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const question = useRef<HTMLHeadingElement>(null);
  const replyInput = useRef<HTMLInputElement>(null);
  const [reply, setReply] = useState('');
  const prompt = active?.question;
  const asking = Boolean(active?.question);
  const step = run.steps.find(item => item.status === 'running');
  const failures = run.steps.filter(item => item.status === 'failed');
  const processed = run.steps.filter(item => item.status === 'completed' || item.status === 'failed').length;
  const status = active?.cancelling ? 'Stopping' : asking ? 'Your input needed' : statusLabels[run.status];
  const mood: Mood = asking || run.status === 'waiting' ? 'waiting' : run.status === 'running' ? 'working'
    : run.status === 'failed' || run.status === 'interrupted' ? 'failed' : run.status === 'completed' ? 'completed' : 'idle';
  const details = useRef<HTMLDetailsElement>(null);
  function reviewSteps() {
    if (!details.current) return;
    details.current.open = true;
    details.current.querySelector('summary')?.focus();
  }
  useEffect(() => { title.current?.focus(); }, [run.id]);
  useEffect(() => {
    if (!prompt) return;
    if (prompt.kind === 'text') replyInput.current?.focus();
    else question.current?.focus();
  }, [prompt?.kind]);
  function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!reply.trim()) return;
    perform(() => api.answer(run.id, reply.trim()));
    setReply('');
  }

  return <main className="task-surface arrive">
    <div className="task-scroll">
      <div className="task-heading">
        <div>
          <span className={`badge ${asking ? 'waiting' : run.status}`} role="status">{status}</span>
          <h1 ref={title} tabIndex={-1}>{taskTitle(run)}</h1>
          {run.description && <p>{run.description}</p>}
          {run.routine && <span className="routine-note"><Icon name="bolt"/> Using your routine</span>}
        </div>
        {settings.showCompanion && <Companion mood={mood} animated={settings.animateCompanion}/>}
      </div>
      {(run.steps.length > 0 || active) && <div className="progress-section">
        <div className="progress-label"><span>{asking ? 'Waiting for confirmation' : step && active ? step.label : active?.phase ?? 'Step progress'}</span>
          {run.steps.length > 0 && <span>{processed}{active?.agent ? "" : " of " + run.steps.length} processed</span>}</div>
        {run.steps.length && !active?.agent ? <progress aria-label="Steps processed" value={processed} max={run.steps.length}/>
          : <progress aria-label="Task progress"/>}
      </div>}
      {prompt ? <section className="question">
        <h2 ref={question} tabIndex={-1}>{prompt.kind === 'local' ? 'Open this file or folder?' : prompt.text}</h2>
        {prompt.kind === 'local' && <><p className="path">{prompt.path}</p><p>Windows will use its default app for this item.</p></>}
        {prompt.kind === 'approval' && <p className="path approval-detail">{prompt.detail}</p>}
        {prompt.kind === 'login' && <p>Complete this step in the Sidekick browser, then summon Sidekick again to continue.</p>}
        {prompt.kind === 'text' && <form className="reply" id="agent-reply" onSubmit={sendReply}>
          <input ref={replyInput} aria-label="Your answer" maxLength={600} placeholder="Type your answer…" value={reply} onChange={event => setReply(event.target.value)}/>
        </form>}
      </section> : <p className={`task-message ${run.status}`}>
        {active?.cancelling ? 'Finishing the current action before stopping.' : active ? active.phase ?? run.message : run.message}
      </p>}
      <Details key={run.id} run={run} element={details}/>
    </div>
    <footer className="task-footer">
      {prompt ? <>
        <button className="secondary" onClick={() => perform(() => api.cancel(run.id))}>Cancel task</button>
        {prompt.kind === 'text' && <button className="primary" type="submit" form="agent-reply" disabled={!reply.trim()}>Send answer</button>}
        {prompt.kind === 'local' && <button className="primary" onClick={() => perform(() => api.answer(run.id, true))}>Open item</button>}
        {prompt.kind === 'approval' && <>
          <button className="secondary" onClick={() => perform(() => api.answer(run.id, false))}>Decline</button>
          <button className="primary" onClick={() => perform(() => api.answer(run.id, true))}>Allow</button>
        </>}
        {prompt.kind === 'login' && <>
          <button className="secondary" onClick={() => perform(() => api.openBrowser())}>Open browser</button>
          <button className="primary" onClick={() => perform(() => api.answer(run.id, true))}>Resume</button>
        </>}
      </> : active ? <button className="secondary" disabled={active.cancelling} onClick={() => perform(() => api.cancel(run.id))}>{active.cancelling ? 'Stopping…' : 'Cancel task'}</button>
        : run.status === 'waiting' ? <><button className="secondary" onClick={next}>New command</button><button className="primary" onClick={setup}>Open settings</button></>
        : run.status === 'failed' || run.status === 'interrupted' ? <>
          {failures.length > 0 && <button className="secondary" onClick={reviewSteps}>Review steps</button>}
          <button className="primary" onClick={edit}>Edit command</button>
        </> : <button className="secondary" onClick={next}>New command</button>}
    </footer>
  </main>;
}

type Tab = 'Recent tasks' | 'Settings';
const tabs: { name: Tab; icon: IconName; description: string }[] = [
  { name: 'Recent tasks', icon: 'history', description: 'Review what ran and how each action finished.' },
  { name: 'Settings', icon: 'settings', description: 'Manage your model, browser, and desktop preferences.' },
];
function Workspace({ snapshot, tab, select, command, task }: {
  snapshot: Snapshot; tab: Tab; select: (tab: Tab) => void; command: () => void; task: () => void;
}) {
  const current = tabs.find(item => item.name === tab)!;
  return <div className="workspace arrive">
    <aside className="sidebar">
      <nav aria-label="Workspace sections">{tabs.map(item => <button key={item.name} aria-current={tab === item.name ? 'page' : undefined} onClick={() => select(item.name)}>
        <Icon name={item.icon}/><span>{item.name}</span>
      </button>)}</nav>
      <span className="sidebar-footer"><kbd>{snapshot.settings.shortcut}</kbd><span>Open Sidekick</span></span>
    </aside>
    <main className="workspace-content">
      <div className="workspace-heading">
        <div><h1>{tab}</h1><p>{current.description}</p></div>
        <button className="secondary" onClick={snapshot.active ? task : command}><Icon name="terminal"/>{snapshot.active ? 'View task' : 'Command bar'}</button>
      </div>
      {tab === 'Settings' && <SettingsPanel original={snapshot.settings} credentialSaved={snapshot.credentialSaved} chatgpt={snapshot.chatgpt}/>}
      {tab === 'Recent tasks' && (snapshot.runs.length ? <section className="history-list" aria-label="Runs">{snapshot.runs.map(run =>
        <article className="history-item" key={run.id}>
          <div className="history-heading"><h2>{run.routine ?? run.command}</h2><span className={`badge ${run.status}`}>{statusLabels[run.status]}</span></div>
          <p>{run.message}</p><Details run={run}/>
        </article>)}</section> : <div className="empty-card"><Icon name="history"/><h2>No tasks yet</h2>
          <p>Tasks will appear here once you run a command.</p><button className="secondary" onClick={command}>Open command bar</button></div>)}
    </main>
  </div>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [tab, setTab] = useState<Tab>('Recent tasks');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  function perform(action: () => Promise<void>) {
    setError('');
    void action().catch(error => setError(errorText(error)));
  }
  const navigate = (surface: Surface) => perform(() => api.show(surface));
  const hide = () => perform(() => api.hide());

  useEffect(() => {
    let alive = true;
    let updated = false;
    const unsubscribe = api.onUpdate(next => { updated = true; setSnapshot(next); });
    const unsubscribeSummon = api.onSummon(() => requestAnimationFrame(() => input.current?.focus()));
    void api.snapshot().then(next => { if (alive && !updated) setSnapshot(next); })
      .catch(error => { if (alive) setError(errorText(error)); });
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) void api.hide();
    };
    window.addEventListener('keydown', escape);
    return () => { alive = false; unsubscribe(); unsubscribeSummon(); window.removeEventListener('keydown', escape); };
  }, []);

  async function run(value: string) {
    if (!value.trim() || busy || snapshot?.active) return;
    setError('');
    setBusy(true);
    try { await api.run(value); setCommand(''); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  const surface = snapshot?.surface ?? 'command';
  const latest = snapshot?.runs[0];
  const newCommand = () => { setCommand(''); navigate('command'); };
  const viewTask = () => navigate('task');
  const openSettings = () => { setTab('Settings'); navigate('workspace'); };
  return <div className={`app ${surface}`}>
    <Titlebar surface={surface} navigate={navigate} settings={openSettings} hide={hide}/>
    {error && <p className="notice app-error" role="alert">{error}</p>}
    {snapshot && (surface === 'workspace'
      ? <Workspace snapshot={snapshot} tab={tab} select={setTab} command={newCommand} task={viewTask}/>
      : surface === 'task' && latest
        ? <TaskCard key={latest.id} run={latest} active={snapshot.active} settings={snapshot.settings} next={newCommand}
          edit={() => { setCommand(latest.command); navigate('command'); }}
          setup={openSettings} perform={perform}/>
        : <CommandBar snapshot={snapshot} command={command} change={setCommand} run={value => void run(value)}
          input={input} busy={busy} task={viewTask}/>)}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);



