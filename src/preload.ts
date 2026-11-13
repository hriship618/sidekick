import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { RoveApi, Snapshot } from './contracts.ts';

const api: RoveApi = {
  heartbeat: () => ipcRenderer.invoke('sidekick:heartbeat'),
  companionLayout: regions => ipcRenderer.invoke('sidekick:companion-layout', regions),
  companionHit: interactive => ipcRenderer.invoke('sidekick:companion-hit', interactive),
  moveCompanion: position => ipcRenderer.invoke('sidekick:companion-move', position),
  grabCompanion: pointer => ipcRenderer.invoke('sidekick:companion-grab', pointer),
  launcherPosition: x => ipcRenderer.invoke('sidekick:launcher-position', x),
  snapshot: () => ipcRenderer.invoke('sidekick:snapshot'),
  saveSettings: settings => ipcRenderer.invoke('sidekick:settings', settings),
  run: command => ipcRenderer.invoke('sidekick:run', command),
  hide: () => ipcRenderer.invoke('sidekick:hide'),
  show: surface => ipcRenderer.invoke('sidekick:show', surface),
  cancel: id => ipcRenderer.invoke('sidekick:cancel', id),
  answer: (id, answer) => ipcRenderer.invoke('sidekick:answer', { id, answer }),
  credential: action => ipcRenderer.invoke('sidekick:credential', action),
  openBrowser: () => ipcRenderer.invoke('sidekick:browser'),
  chatgpt: action => ipcRenderer.invoke('sidekick:chatgpt', action),
  onSummon(callback) {
    const listener = () => callback();
    ipcRenderer.on('sidekick:summon', listener);
    return () => ipcRenderer.removeListener('sidekick:summon', listener);
  },
  onUpdate(callback) {
    const listener = (_event: IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('sidekick:update', listener);
    return () => ipcRenderer.removeListener('sidekick:update', listener);
  },
};
contextBridge.exposeInMainWorld('sidekick', api);
