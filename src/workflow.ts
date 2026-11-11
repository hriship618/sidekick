import type { Action } from './tools.ts';

export function planCommand(command: string): { actions: Action[]; description: string } | undefined {
  const url = /^open (https?:\/\/\S+)$/i.exec(command);
  if (url) return { description: 'Open the link in your default browser.', actions: [{ label: 'Open link', tool: 'openUrl', input: { url: url[1] } }] };
  const local = /^open ((?:[a-z]:\\)[^\r\n]+)$/i.exec(command);
  if (local) return { description: 'Open a file or folder with Windows.', actions: [{ label: 'Open local item', tool: 'openLocal', input: { path: local[1] } }] };
}

