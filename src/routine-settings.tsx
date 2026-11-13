import type { Settings } from './contracts.ts';

export function RoutineSettings({ value, change }: { value: Settings['routines']; change: (value: Settings['routines']) => void }) {
  return <fieldset>
    <legend>Saved routines</legend>
    {value.map((routine, index) => <section className="routine-editor" key={routine.id}>
      <label>Routine name<input value={routine.name} placeholder="Name this routine" required maxLength={80}
        onChange={event => change(value.map(item => item.id === routine.id ? { ...item, name: event.target.value } : item))}/></label>
      <label>Resource URLs or local paths, one per line<textarea rows={3}
        value={routine.resources.join('\n')}
        onChange={event => change(value.map(item => item.id === routine.id ? { ...item, resources: event.target.value.split('\n') } : item))}
        onBlur={() => change(value.map(item => item.id === routine.id ? { ...item, resources: item.resources.map(line => line.trim()).filter(Boolean) } : item))}/>
      </label>
      <div className="routine-ssh">
        <label>SSH alias<input value={routine.sshAlias} onChange={event => change(value.map(item => item.id === routine.id ? { ...item, sshAlias: event.target.value } : item))}/></label>
        <label>Remote directory<input value={routine.remoteDir} placeholder="~/workspace" onChange={event => change(value.map(item => item.id === routine.id ? { ...item, remoteDir: event.target.value } : item))}/></label>
      </div>
      <button className="quiet danger" type="button" onClick={() => change(value.filter((_, position) => position !== index))}>Remove routine</button>
    </section>)}
    <button className="secondary" type="button" disabled={value.length >= 30}
      onClick={() => change([...value, { id: crypto.randomUUID(), name: '', resources: [], sshAlias: '', remoteDir: '' }])}>Add routine</button>
  </fieldset>;
}
