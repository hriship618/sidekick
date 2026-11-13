import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActiveRun, Run, Settings, RoveApi, Snapshot, Surface } from './contracts.ts';
import { Companion, type Mood } from './companion.tsx';
import { errorText, SettingsPanel } from './settings.tsx';
import './style.css';
import { CompanionOverlay } from './companion-overlay.tsx';
import { LauncherCompanion } from './launcher-companion.tsx';

declare global { interface Window { sidekick: RoveApi } }
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
    <div className="brand"><span className="brand-mark"><Icon name="bolt"/></span>Rove</div>
    <div className="title-actions">
      {surface !== 'workspace' && <button className="quiet icon-button" aria-label="Workspace" title="Workspace" onClick={() => navigate('workspace')}><Icon name="grid"/></button>}
      {surface !== 'workspace' && <button className="quiet icon-button" aria-label="Settings" title="Settings" onClick={settings}><Icon name="settings"/></button>}
      <button className="quiet icon-button" onClick={hide} title="Hide Rove (Esc)" aria-label="Hide Rove"><Icon name="close"/></button>
    </div>
  </header>;
}

function CommandBar({ snapshot, command, change, run, input, busy, task, settings, workspace, error }: {
  snapshot: Snapshot; command: string; change: (value: string) => void; run: (value: string) => void;
  input: React.RefObject<HTMLInputElement | null>; busy: boolean; task: () => void;
  settings: () => void; workspace: () => void;
  error: string;
}) {
  const active = Boolean(snapshot.active);
  useEffect(() => { input.current?.focus(); }, [input]);

  function submit(event: FormEvent) {
    event.preventDefault();
    run(command);
  }

  return <main className="command-surface arrive">
    {snapshot.settings.showCompanion && <LauncherCompanion command={command} settings={snapshot.settings}/>}
    <form className="command-field" onSubmit={submit}>
      <span className="prompt"><Icon name="terminal"/></span>
      <input ref={input} aria-label="Command" placeholder="Ask Rove…" maxLength={4096}
        value={command} onChange={event => change(event.target.value)}/>
      <button type="button" className="quiet icon-button" onClick={workspace} aria-label="Open workspace" title="Routines and recent tasks"><Icon name="grid"/></button>
      <button type="button" className="quiet icon-button" onClick={settings} aria-label="Open settings" title="Settings"><Icon name="settings"/></button>
      <button className="primary run-button" aria-label="Run command" title="Run (Enter)" disabled={busy || active || !command.trim()}><Icon name="arrow"/></button>
    </form>
    <footer className="command-footer">
      {error ? <span className="launcher-error" title={error} role="alert">{error}</span> : <button className="quiet provider-label" onClick={settings} title={snapshot.shortcutWarning || 'Connection settings'}>
        <span className={`connection-dot ${(snapshot.settings.connectionMode === 'chatgpt' ? snapshot.chatgpt.sharing : snapshot.credentialSaved) ? 'connected' : ''}`}/>
        {snapshot.shortcutWarning ? 'Shortcut unavailable' : snapshot.settings.connectionMode === 'chatgpt' ? snapshot.chatgpt.sharing ? 'ChatGPT' : 'Connect ChatGPT' : snapshot.credentialSaved ? 'OpenAI' : 'Connect OpenAI'}
      </button>}
      {(active || snapshot.runs.length > 0) && <button className="quiet last-task" onClick={task}>{active ? 'View running task' : 'Last task'}</button>}
      <span className="key-hints"><kbd>↵</kbd> run <kbd>Esc</kbd> hide</span>
    </footer>
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
        {run.engine && <p className="muted" aria-label="Execution engine metrics">
          {run.engine.modelCalls === 0 ? 'Executed locally · 0 model calls' : `${run.engine.modelCalls} model call${run.engine.modelCalls === 1 ? '' : 's'}`}
          {run.engine.graphPlans > 0 && ` · ${run.engine.graphPlans} execution graph${run.engine.graphPlans === 1 ? '' : 's'}`}
          {run.engine.usageReported && ` · ${run.engine.inputTokens.toLocaleString()} input tokens (${run.engine.cachedInputTokens.toLocaleString()} cached) · ${run.engine.outputTokens.toLocaleString()} output tokens`}
          {run.engine.reducedChars > 0 && ` · ${run.engine.reducedChars.toLocaleString()} observation characters omitted from model context`}
        </p>}
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
  const conversationEnd = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const prompt = active?.question;
  const asking = Boolean(active?.question);
  const unknownTotal = Boolean(active?.agent || active?.indeterminate);
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
  useEffect(() => { setSending(false); }, [run.id, active?.questionId]);
  useEffect(() => { if (!active) replyInput.current?.focus(); }, [run.id, Boolean(active)]);
  useEffect(() => {
    if (!prompt) return;
    if (prompt.kind === 'text') replyInput.current?.focus();
    else question.current?.focus();
  }, [prompt?.kind, prompt && ('text' in prompt ? prompt.text : prompt.path)]);
  useLayoutEffect(() => { if (followMessages.current) conversationEnd.current?.scrollIntoView({ block: 'end' }); }, [run.messages?.at(-1)?.id]);
  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!reply.trim() || sending || (active && prompt?.kind !== 'text')) return;
    const text = reply.trim(); setSending(true); setReply(''); followMessages.current = true;
    try {
      await (prompt?.kind === 'text' ? api.answer(run.id, text) : api.followUp(run.id, text));
    } catch (error) { setReply(draft => draft || text); perform(() => Promise.reject(error)); }
    finally { setSending(false); }
  }

  return <main className="task-surface arrive">
    {(active || run.routine) && <div className="task-overview">
      <div className="task-heading">
        <div>
          <span className="chat-state" role="status">{asking ? 'Waiting for your reply' : active?.cancelling ? 'Stopping…' : 'Working'}</span>
          {run.routine && <span className="routine-note"><Icon name="bolt"/> Using your routine</span>}
        </div>
        {settings.showCompanion && <Companion mood={mood} animated={settings.animateCompanion}/>}
      </div>
      {run.steps.length > 0 && active && <div className="progress-section">
        <div className="progress-label"><span>{asking ? 'Waiting for your reply' : step && active ? step.label : active?.phase ?? 'Step progress'}</span>
          {run.steps.length > 0 && <span>{processed}{unknownTotal ? "" : " of " + run.steps.length} processed</span>}</div>
        {run.steps.length && !unknownTotal ? <progress aria-label="Steps processed" value={processed} max={run.steps.length}/>
          : <progress aria-label="Task progress"/>}
      </div>}
    </div>}
    <div className="task-scroll" onScroll={event => { const area = event.currentTarget; followMessages.current = area.scrollHeight - area.scrollTop - area.clientHeight < 90; }}>
      <section className="conversation" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
        {(run.messages?.length ? run.messages : [{ id: -1, role: 'user' as const, text: run.command, at: run.createdAt }]).map(message =>
          <article className={`chat-message ${message.role}`} aria-label={message.role === 'user' ? 'You' : 'Rove'} key={message.id}>
            <span className="chat-speaker">{message.role === 'user' ? 'You' : 'Rove'}</span>
            <p>{message.text}</p>
          </article>)}
        {active && !prompt && <p className="chat-working" role="status">{active.cancelling ? 'Stopping…' : active.phase ?? 'Working…'}</p>}
        <div ref={conversationEnd}/>
      </section>
      {prompt && prompt.kind !== 'text' ? <section className="question chat-question">
        <h2 ref={question} tabIndex={-1}>{prompt.kind === 'login' ? 'Sign in to continue' : 'Your confirmation'}</h2>
        {prompt.kind === 'local' && <><p className="path">{prompt.path}</p><p>Windows will use its default app for this item.</p></>}
        {prompt.kind === 'approval' && <p className="path approval-detail">{prompt.detail}</p>}
        {prompt.kind === 'login' && <p>Sign in in the Rove browser, then select Resume below.</p>}
      </section> : !active && !run.messages?.some(message => message.role === 'assistant') && <p className={`task-message ${run.status}`}>{run.message}</p>}
      <Details key={run.id} run={run} element={details}/>
    </div>
    <footer className="task-footer chat-footer">
      <form className="chat-compose" id="agent-reply" onSubmit={sendReply}>
        <input ref={replyInput} aria-label={prompt ? 'Your answer' : 'Message Rove'} maxLength={600}
          placeholder={prompt ? 'Reply to Rove…' : 'Message Rove…'} value={reply} onChange={event => setReply(event.target.value)}/>
        <button className="primary chat-send" aria-label="Send" title="Send" type="submit" disabled={!reply.trim() || sending || Boolean(active && prompt?.kind !== 'text')}><span aria-hidden="true">↑</span></button>
      </form>
      <div className="chat-actions">
      {prompt ? <>
        <button className="secondary" onClick={() => perform(() => api.cancel(run.id))}>Cancel task</button>
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
        </> : <button className="quiet" onClick={next}>New chat</button>}
      </div>
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
      <span className="sidebar-footer"><kbd>{snapshot.settings.shortcut}</kbd><span>Open Rove</span></span>
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
    const beat = () => {
      const ready = location.hash === '#companion' ? document.querySelector('[data-creature]') : document.querySelector('.command-field,.task-surface,.workspace');
      if (ready) void api.heartbeat().catch(() => {});
    };
    const healthTimer = setInterval(beat, 1500);
    let updated = false;
    const unsubscribe = api.onUpdate(next => { updated = true; setSnapshot(next); });
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const focusComposer = () => {
      const focus = () => {
        if (!document.hasFocus()) return;
        const field = document.querySelector<HTMLInputElement>('.command-field input,.chat-compose input');
        field?.focus({ preventScroll: true });
      };
      requestAnimationFrame(focus);
      clearTimeout(focusTimer);
      // Windows may deliver activation after the global chord's Alt key is released.
      focusTimer = setTimeout(focus, 90);
    };
    const unsubscribeSummon = api.onSummon(focusComposer);
    window.addEventListener('focus', focusComposer);
    void api.snapshot().then(next => { if (alive && !updated) setSnapshot(next); })
      .catch(error => { if (alive) setError(errorText(error)); });
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) void api.hide();
    };
    window.addEventListener('keydown', escape);
    return () => { alive = false; clearInterval(healthTimer); clearTimeout(focusTimer); unsubscribe(); unsubscribeSummon(); window.removeEventListener('focus', focusComposer); window.removeEventListener('keydown', escape); };
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
  useEffect(() => { document.documentElement.dataset.surface = surface; }, [surface]);
  const latest = snapshot?.runs[0];
  const newCommand = () => { setCommand(''); navigate('command'); };
  const viewTask = () => navigate('task');
  const openSettings = () => { setTab('Settings'); navigate('workspace'); };
  if (location.hash === '#companion') return snapshot ? <CompanionOverlay snapshot={snapshot}/> : null;
  if (!snapshot) return <main className="startup-screen" role="status">
    <strong>Rove</strong><p>{error || 'Opening your chat…'}</p>
    {error && <button className="primary" onClick={() => location.reload()}>Try again</button>}
  </main>;
  return <div className={`app ${surface} ${snapshot?.settings.showCompanion === false ? 'no-companion' : ''}`}>
    {surface !== 'command' && <Titlebar surface={surface} navigate={navigate} settings={openSettings} hide={hide}/>}
    {error && surface !== 'command' && <p className="notice app-error" role="alert">{error}</p>}
    {snapshot && (surface === 'workspace'
      ? <Workspace snapshot={snapshot} tab={tab} select={setTab} command={newCommand} task={viewTask}/>
      : surface === 'task' && latest
        ? <TaskCard run={latest} active={snapshot.active} settings={snapshot.settings} next={newCommand}
          edit={() => { setCommand(latest.command); navigate('command'); }}
          setup={openSettings} perform={perform}/>
        : <CommandBar snapshot={snapshot} command={command} change={setCommand} run={value => void run(value)}
          input={input} busy={busy} task={viewTask} settings={openSettings} workspace={() => navigate('workspace')} error={error}/>)}
  </div>;
}

if (location.hash === '#companion') document.documentElement.dataset.overlay = 'true';
createRoot(document.getElementById('root')!).render(<App/>);
