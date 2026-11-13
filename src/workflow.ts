import { defaults, type Settings } from './contracts.ts';
import type { Action } from './tools.ts';

const publicSites: Record<string, string> = {
  youtube: 'https://www.youtube.com/', google: 'https://www.google.com/', github: 'https://github.com/',
  wikipedia: 'https://www.wikipedia.org/', gmail: 'https://mail.google.com/',
};
export function closeIntent(command: string) {
  const match = /^(?:please\s+)?close\s+(?:the\s+)?(.+?)[.!]?$/i.exec(command.trim());
  if (!match || /\b(?:and|then|after|before|all|everything|tab|tabs|account|issue|ticket|if|unless|without|save|saving|force|kill)\b|[\r\n;,]/i.test(match[1])) return;
  const name = match[1].replace(/^['"]|['"]$/g, '').trim();
  if (name.length < 2 || name.length > 80 || /^(?:app|application|window|rove|sidekick|this|current|active)(?:\s+(?:app|window))?$/i.test(name)) return;
  return name;
}
export function routineActions(routine: Settings['routines'][number]): Action[] {
  return [
    ...routine.resources.map((resource, index) => /^https?:/i.test(resource)
      ? { label: `Open resource ${index + 1}`, tool: 'openUrl' as const, input: { url: resource } }
      : { label: `Open resource ${index + 1}`, tool: 'openLocal' as const, input: { path: resource } }),
    ...(routine.sshAlias && routine.remoteDir ? [{
      label: 'Launch SSH workspace', tool: 'sshWorkspace' as const,
      input: { alias: routine.sshAlias, directory: routine.remoteDir },
    }] : []),
  ];
}
export function planCommand(command: string, settings: Settings = defaults): { actions: Action[]; description: string; routine?: string } | undefined {
  const routine = settings.routines.find(item => item.name.toLowerCase() === command.trim().toLowerCase());
  if (routine && routine.resources.length && Boolean(routine.sshAlias) === Boolean(routine.remoteDir)) {
    return { description: `Open the resources saved in ${routine.name}.`, routine: routine.name, actions: routineActions(routine) };
  }
  const site = /^open\s+(.+?)\s*[.!]?$/i.exec(command);
  if (site && publicSites[site[1].toLowerCase()]) {
    return { description: 'Open the requested website.', actions: [{ label: `Open ${site[1]}`, tool: 'openUrl', input: { url: publicSites[site[1].toLowerCase()] } }] };
  }
  const explicitUrl = /^open (https?:\/\/\S+)$/i.exec(command);
  if (explicitUrl) return { description: 'Open the requested link.', actions: [{ label: 'Open link', tool: 'openUrl', input: { url: explicitUrl[1] } }] };
  const links = command.match(/https?:\/\/[^\s<>"\[\]]+/gi);
  if (/^open\b/i.test(command) && links?.length && !/\b(?:then|inspect|read|click|fill|review|search|summarize|tell)\b/i.test(command)) {
    return { description: `Open ${links.length === 1 ? 'the link' : 'the links'} in your default browser.`,
      actions: links.map(url => ({ label: 'Open link', tool: 'openUrl', input: { url: url.replace(/[,.]$/, '') } })) };
  }
  // Local paths are admitted by the graph router, which rejects compound requests.
}
