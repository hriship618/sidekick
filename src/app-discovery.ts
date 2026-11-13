export type InstalledApp = { applicationId: string; name: string; productName?: string; description?: string; target?: string; source?: string };
export function launchIntent(command: string) {
  const match = /^(?:please\s+)?(?:open|launch|start|bring up)\s+(?:the\s+)?(?:(?:app|application)\s+)?(.+?)[.!]?$/i.exec(command.trim());
  if (!match) return;
  const name = match[1].replace(/^['"]|['"]$/g, '').trim();
  if (/^(?:it|that|this|them|those|the same app|the previous app|my workspace|an? app|application)$/i.test(name)) return;
  if (name.length < 2 || name.length > 80 || /[:\\/;`$\r\n]|\b(?:and|then|after|before|unless|if|all|tomorrow|later|folder|file|directory|website|page|search|read|with|in|at)\b/i.test(name)) return;
  return name;
}
/** Match current Windows evidence, never assume a marketing name equals an executable name. */
export function selectApplications(query: string, apps: InstalledApp[]) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\.exe$/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const wanted = normalize(query);
  if (!wanted) return [];
  const score = (app: InstalledApp) => {
    if (normalize(app.name) === wanted) return 1000;
    if (normalize(app.productName ?? '') === wanted) return 900;
    const words = wanted.split(' ');
    const target = app.source === 'Windows shortcut' ? app.target?.split(/[\\/]/).at(-1) : app.target;
    const identity = normalize([app.name, app.productName, app.description, target].filter(Boolean).join(' '));
    return words.every(word => identity.split(' ').includes(word)) ? 200 : identity.includes(wanted) ? 100 : 0;
  };
  const ranked = apps.map(app => ({ app, score: score(app) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score;
  return ranked.filter(item => item.score === best).map(item => item.app);
}
