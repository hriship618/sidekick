import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SidekickApi, Snapshot } from './contracts.ts';

const api: SidekickApi = {
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

