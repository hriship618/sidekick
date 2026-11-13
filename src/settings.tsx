import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RoutineSettings } from './routine-settings.tsx';
import type { ChatGPTAction, ChatGPTStatus, Settings } from './contracts.ts';

export function SettingsPanel({ original, credentialSaved, chatgpt }: { original: Settings; credentialSaved: boolean; chatgpt: ChatGPTStatus }) {
  const [draft, setDraft] = useState(original);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connection, setConnection] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (chatgpt.welcome && !modal.current?.open) modal.current?.showModal();
  }, [chatgpt.welcome]);

  async function plan(action: ChatGPTAction) {
    const background = action.action === 'cancel' || action.action === 'dismiss' || action.action === 'usage';
    if (!background) { setPlanBusy(true); setConnection(''); }
    setError('');
    if (action.action === 'signIn' || action.action === 'addAccount') setDraft(previous => ({ ...previous, connectionMode: 'chatgpt' }));
    try {
      const message = await window.sidekick.chatgpt(action);
      if (message) setConnection(message);
    } catch (error) { setError(errorText(error)); }
    finally { if (!background) setPlanBusy(false); }
  }
  async function connect(action: 'set' | 'paste' | 'test' | 'clear' | 'browser') {
    setConnectionBusy(true);
    setError('');
    setConnection('');
    try {
      if (action === 'browser') await window.sidekick.openBrowser();
      else setConnection(await window.sidekick.credential(action));
    } catch (error) { setError(errorText(error)); }
    finally { setConnectionBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try { setDraft(await window.sidekick.saveSettings(draft)); setSaved(true); }
    catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  }

  return <form className="settings" onSubmit={save} onChange={() => setSaved(false)}>
    <fieldset>
      <legend>AI connection</legend>
      <label>Use for Rove tasks
        <select value={draft.connectionMode} disabled={planBusy || chatgpt.busy} onChange={event => setDraft({ ...draft, connectionMode: event.target.value === 'apiKey' ? 'apiKey' : 'chatgpt' })}>
          <option value="chatgpt">ChatGPT plan</option>
          <option value="apiKey">OpenAI API key (separate billing)</option>
        </select>
      </label>
      {draft.connectionMode !== original.connectionMode && <p className="muted">Select Save settings to switch how Rove runs tasks.</p>}
      {draft.connectionMode === 'chatgpt' ? <>
        <p className="muted">{chatgpt.sharing ? 'Using ChatGPT plan.' : 'Connect an eligible ChatGPT account to use your plan allowance in Rove.'}</p>
        {chatgpt.profiles.length > 0 && <label>ChatGPT account
          <select value={chatgpt.selectedId} disabled={chatgpt.busy || planBusy} onChange={event => void plan({ action: 'select', id: event.target.value })}>
            {!chatgpt.selectedId && <option value="">Choose an account</option>}
            {chatgpt.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.connected ? '' : ' (signed out)'}</option>)}
          </select>
        </label>}
        {chatgpt.models.length > 0 && <label>ChatGPT model
          <select value={chatgpt.models.some(item => item.slug === draft.chatgptModel) ? draft.chatgptModel : chatgpt.models[0].slug}
            onChange={event => setDraft({ ...draft, chatgptModel: event.target.value })}>
            {chatgpt.models.map(model => <option key={model.slug} value={model.slug}>{model.name}</option>)}
          </select>
        </label>}
        <div className="actions wrap">
          {!chatgpt.sharing && <button className="chatgpt-sign-in" data-oai-siwc-button="" type="button" disabled={planBusy || chatgpt.busy} onClick={() => void plan({ action: 'signIn' })}>Continue with ChatGPT</button>}
          {chatgpt.signingIn && <button className="secondary" type="button" onClick={() => void plan({ action: 'cancel' })}>Cancel sign-in</button>}
          {chatgpt.sharing && <button className="secondary" type="button" disabled={planBusy || draft.chatgptModel !== original.chatgptModel}
            onClick={() => void plan({ action: 'test' })}>Test ChatGPT connection</button>}
          {chatgpt.sharing && !chatgpt.models.length && <button className="secondary" type="button" disabled={planBusy}
            onClick={() => void plan({ action: 'refresh' })}>Refresh models</button>}
          {chatgpt.connected && <button className="quiet" type="button" disabled={planBusy || chatgpt.busy} onClick={() => void plan({ action: 'signOut' })}>Sign out</button>}
          {chatgpt.profiles.length > 0 && <button className="quiet" type="button" disabled={planBusy || chatgpt.busy} onClick={() => void plan({ action: 'addAccount' })}>Add account</button>}
          <button className="quiet" type="button" onClick={() => void plan({ action: 'usage' })}>Manage usage</button>
        </div>
        {chatgpt.signingIn && <p role="status">Finish signing in and approving access in your browser.</p>}
        {chatgpt.notice && !error && <p role="status" className="muted">{chatgpt.notice}</p>}
      </> : <>
      <p className="muted">API requests are billed separately through your OpenAI API project.</p>
      <label>Model ID<input value={draft.model} required maxLength={120} onChange={e => setDraft({ ...draft, model: e.target.value })}/></label>
      <div className="actions wrap">
        <button className="primary" type="button" onClick={() => void connect('paste')}>{credentialSaved ? 'Paste replacement key' : 'Paste API key'}</button>
        <button className="secondary" type="button" onClick={() => void connect('set')}>{credentialSaved ? 'Replace API key' : 'Enter API key'}</button>
        <button className="secondary" type="button" disabled={!credentialSaved || draft.model !== original.model} onClick={() => void connect('test')}>Test saved model</button>
        {credentialSaved && <button className="quiet" type="button" onClick={() => void connect('clear')}>Remove key</button>}
      </div>
      {draft.model !== original.model && <p className="muted">Save settings before testing the new model.</p>}
      <p className="muted">{credentialSaved ? 'A Windows-protected API key is saved.' : 'Copy your OpenAI API key, then click Paste API key. You can also enter it in a masked Windows dialog.'}</p>
      </>}
      {connectionBusy && <p role="status">Working…</p>}
      {connection && <p role="status">{connection}</p>}
    </fieldset>
    {chatgpt.welcome && <dialog ref={modal} className="welcome-dialog" onCancel={event => { event.preventDefault(); void plan({ action: 'dismiss' }); }}>
      <h2>You’re using your ChatGPT plan</h2>
      <p>Eligible Rove tasks use your ChatGPT allowance. Manage your limits and credit use in ChatGPT settings.</p>
      <div className="actions wrap">
        <button className="secondary" type="button" onClick={() => void plan({ action: 'usage' })}>Manage usage</button>
        <button className="primary" type="button" onClick={() => void plan({ action: 'dismiss' })}>Got it</button>
      </div>
    </dialog>}
    <fieldset disabled={connectionBusy || saving}>
      <legend>Browser</legend>
      <div className="actions wrap"><button className="secondary" type="button" onClick={() => void connect('browser')}>Open Rove browser</button>
        <span className="muted">Microsoft Edge · dedicated profile</span></div>
      <p className="muted">Sign in directly in this browser when a website needs it. Summon Rove to return.</p>
    </fieldset>
    {error && <p className="notice" role="alert">{error}</p>}
    <RoutineSettings value={draft.routines} change={routines => { setDraft({ ...draft, routines }); setSaved(false); }}/>
    <fieldset disabled={saving}>
      <legend>Desktop</legend>
      <div className="toggles"><label><input type="checkbox" checked={draft.desktopAccess} onChange={event => setDraft({ ...draft, desktopAccess: event.target.checked })}/> Desktop access</label></div>
      <p className="hint">Allow requested Windows window controls, accessibility actions, process management, and PowerShell commands using your Windows account.</p>
      <label>Global shortcut<input value={draft.shortcut} maxLength={45} required onChange={e => setDraft({ ...draft, shortcut: e.target.value })}/></label>
      <label>Preferred taskbar side<select value={draft.restingCorner.endsWith('right') ? 'bottom-right' : 'bottom-left'} onChange={event => setDraft({ ...draft, restingCorner: event.target.value as Settings['restingCorner'], restingPosition: null })}>
        <option value="bottom-right">Right</option><option value="bottom-left">Left</option>
      </select></label>
      <div className="toggles">
        <label><input type="checkbox" checked={draft.quietMode} onChange={event => setDraft({ ...draft, quietMode: event.target.checked })}/> Quiet mode</label>
        <label><input type="checkbox" checked={draft.showCompanion} onChange={e => setDraft({ ...draft, showCompanion: e.target.checked })}/> Show companion</label>
        <label><input type="checkbox" checked={draft.animateCompanion} disabled={!draft.showCompanion}
          onChange={e => setDraft({ ...draft, animateCompanion: e.target.checked })}/> Animate companion</label>
      </div>
    </fieldset>
    <div className="actions">
      <button className="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      {saved && <span role="status" className="success">Settings saved</span>}
    </div>
  </form>;
}

export function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}
