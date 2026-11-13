import { z } from 'zod';
import { localPath } from './contracts.ts';
import { closeIntent } from './workflow.ts';

type Node = { id: string; kind: 'parameter' | 'command'; description: string };
/** Edges mean requires: prerequisites are visited before their consuming command. */
export class CommandGraph {
  private nodes = new Map<string, Node>();
  private requires = new Map<string, string[]>();
  add(node: Node, dependencies: string[] = []) {
    if (this.nodes.has(node.id)) throw new Error(`Duplicate graph node: ${node.id}`);
    this.nodes.set(node.id, Object.freeze({ ...node }));
    this.requires.set(node.id, [...dependencies]);
    return this;
  }
  order(id: string): string[] {
    const active = new Set<string>(), visited = new Set<string>(), result: string[] = [];
    const visit = (key: string) => {
      if (!this.nodes.has(key)) throw new Error(`Unknown graph prerequisite: ${key}`);
      if (active.has(key)) throw new Error('Command graph contains a dependency cycle.');
      if (visited.has(key)) return;
      active.add(key);
      for (const dependency of this.requires.get(key) ?? []) visit(dependency);
      active.delete(key); visited.add(key); result.push(key);
    };
    visit(id); return result;
  }
}

export const windowsGraph = new CommandGraph()
  .add({ id: 'App_Name', kind: 'parameter', description: 'A named application; resolve its live window identity.' })
  .add({ id: 'Path', kind: 'parameter', description: 'A validated absolute Windows path.' })
  .add({ id: 'Amount', kind: 'parameter', description: 'A bounded volume increase in percentage points.' })
  .add({ id: 'Close-App', kind: 'command', description: 'Discover, disambiguate, close gracefully and verify.' }, ['App_Name'])
  .add({ id: 'Open-Dir', kind: 'command', description: 'Open a validated local resource using the existing registry.' }, ['Path'])
  .add({ id: 'Volume-Up', kind: 'command', description: 'Increase default playback endpoint volume and read it back.' }, ['Amount']);

export type LocalRoute = { score: number; reason: string; dependencies: string[] } & (
  { node: 'Close-App'; parameters: { app: string } } |
  { node: 'Open-Dir'; parameters: { path: string } } |
  { node: 'Volume-Up'; parameters: { amount: number } }
);

const examples = {
  'Close-App': ['close app', 'shut application', 'shut down window', 'dismiss application'],
  'Open-Dir': ['open folder', 'show directory', 'open path', 'open file'],
  'Volume-Up': ['volume up', 'increase volume', 'turn volume up', 'raise volume'],
};
const tokens = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];
const documents: { node: string; words: string[] }[] = Object.entries(examples).flatMap(([node, texts]) => texts.map(text => ({ node, words: tokens(text) })));
const vocabulary = [...new Set(documents.flatMap(item => item.words))];
const idf = new Map(vocabulary.map(word => [word, Math.log(1 + documents.length / (1 + documents.filter(item => item.words.includes(word)).length))]));
function vector(words: string[]) { return vocabulary.map(word => words.filter(item => item === word).length * idf.get(word)!); }
const vectors = documents.map(item => ({ node: item.node, vector: vector(item.words) }));
/** TF-IDF is candidate ranking, never a calibrated probability or authorization. */
export function rankLocalIntents(query: string) {
  const queryVector = vector(tokens(query));
  const norm = Math.hypot(...queryVector);
  const scores = new Map<string, number>();
  for (const item of vectors) {
    const score = norm ? item.vector.reduce((sum, value, i) => sum + value * queryVector[i], 0) / (norm * Math.hypot(...item.vector)) : 0;
    scores.set(item.node, Math.max(scores.get(item.node) ?? 0, score));
  }
  return [...scores].map(([node, score]) => ({ node, score })).sort((a, b) => b.score - a.score);
}

/** Conservative grammar admission protects against negation, compound goals and fuzzy false matches. */
export function matchLocalIntent(query: string): LocalRoute | undefined {
  const text = query.trim().replace(/^(?:please|could you|can you)\s+/i, '').replace(/\s+please[.!]?$/i, '');
  const ranked = rankLocalIntents(text);
  let route: Omit<LocalRoute, 'score' | 'reason' | 'dependencies'> | undefined;
  const close = /^(?:close|shut|dismiss)\s+(?:down\s+)?(.+)$/i.exec(text);
  const app = close && closeIntent('close ' + close[1]);
  if (app && !/\b(?:don't|do not|except|not|when|until|but|or|tomorrow|later|tonight|today|next|seconds?|minutes?|hours?|days?|weeks?)\b|\b(?:in|at|on)\s+(?:\d|noon|midnight|one|two|three|ten)/i.test(app)) route = { node: 'Close-App', parameters: { app } };
  const open = /^(?:open|show)\s+(?:(?:the\s+)?(?:folder|directory|file|path)\s+)?("[^"]+"|[a-z]:\\[^\r\n]+)$/i.exec(text);
  if (open) {
    const path = localPath.safeParse(open[1].replace(/^"|"$/g, ''));
    if (path.success && !/\s+(?:and|then|but|after|before|unless|if)\s+/i.test(path.data)) route = { node: 'Open-Dir', parameters: { path: path.data } };
  }
  const volume = /^(?:(?:turn\s+)?(?:the\s+)?volume\s+up|(?:increase|raise)\s+(?:the\s+)?volume)(?:\s+(?:by\s+)?(\d{1,2})(?:\s*(?:%|percent|percentage points))?)?[.!]?$/i.exec(text);
  if (volume) {
    const amount = z.number().int().min(1).max(20).safeParse(Number(volume[1] ?? 5));
    if (amount.success) route = { node: 'Volume-Up', parameters: { amount: amount.data } };
  }
  if (!route) return;
  // Score expresses exact grammar admission, not empirical 99% accuracy. Ranking breaks no safety gates.
  const candidate = ranked.find(item => item.node === route!.node);
  return { ...route, score: 0.99, reason: `Exact supported grammar; TF-IDF similarity ${(candidate?.score ?? 0).toFixed(3)}. Score is not a calibrated probability.`, dependencies: windowsGraph.order(route.node) } as LocalRoute;
}
