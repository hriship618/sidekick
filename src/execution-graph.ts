export type ExecutionNode<A> = { id: string; after: string[]; action: A };
export type GraphResult = { ok: boolean; message: string };
export type GraphEvent = { event: 'start' | 'completed' | 'failed' | 'blocked' | 'cancelled'; node?: string; completed: string[] };

/** Validate the entire plan before dispatch. Stable topological ordering avoids guessed prerequisites. */
export function graphOrder<A>(nodes: ExecutionNode<A>[]): ExecutionNode<A>[] {
  if (!nodes.length || nodes.length > 32) throw new Error('An execution graph needs 1–32 nodes.');
  const index = new Map<string, ExecutionNode<A>>();
  for (const node of nodes) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(node.id) || index.has(node.id)) throw new Error('Graph node IDs must be valid and unique.');
    if (new Set(node.after).size !== node.after.length) throw new Error('A graph prerequisite was listed twice.');
    index.set(node.id, node);
  }
  const visited = new Set<string>(), active = new Set<string>(), ordered: ExecutionNode<A>[] = [];
  const visit = (id: string) => {
    const node = index.get(id);
    if (!node) throw new Error(`Unknown graph prerequisite: ${id}`);
    if (active.has(id)) throw new Error('The execution graph contains a cycle.');
    if (visited.has(id)) return;
    active.add(id);
    node.after.forEach(visit);
    active.delete(id); visited.add(id); ordered.push(node);
  };
  nodes.forEach(node => visit(node.id));
  return ordered;
}

export function linearGraph<A>(actions: A[]): ExecutionNode<A>[] {
  return actions.map((action, i) => ({ id: `step${i + 1}`, after: i ? [`step${i}`] : [], action }));
}

/** Sequential dispatch is intentional: browser tabs and desktop focus are shared mutable state. */
export async function executeGraph<A, R extends GraphResult>(nodes: ExecutionNode<A>[], options: {
  signal: AbortSignal;
  execute(node: ExecutionNode<A>): Promise<R>;
  event?(event: GraphEvent): void;
}) {
  const ordered = graphOrder(nodes);
  const completed: string[] = [], results: { node: string; result: R }[] = [];
  let failedNode: string | undefined;
  for (const node of ordered) {
    if (options.signal.aborted) break;
    options.event?.({ event: 'start', node: node.id, completed: [...completed] });
    const result = await options.execute(node);
    results.push({ node: node.id, result });
    if (!result.ok) {
      failedNode = node.id;
      options.event?.({ event: 'failed', node: node.id, completed: [...completed] });
      break;
    }
    completed.push(node.id);
    options.event?.({ event: 'completed', node: node.id, completed: [...completed] });
  }
  const attempted = new Set(results.map(item => item.node));
  const blocked = ordered.filter(node => !attempted.has(node.id)).map(node => node.id);
  const cancelled = options.signal.aborted;
  if (cancelled) options.event?.({ event: 'cancelled', completed: [...completed] });
  for (const node of blocked) options.event?.({ event: 'blocked', node, completed: [...completed] });
  return { ok: !cancelled && !failedNode && !blocked.length, cancelled, completed, blocked, failedNode, results };
}
