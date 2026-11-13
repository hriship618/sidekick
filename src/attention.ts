import type { ActiveRun, Run } from './contracts.ts';
export function attentionKey(active: ActiveRun | null, latest?: Run): string | undefined {
  if (active?.question) return active.id + ':' + (active.questionId ?? JSON.stringify(active.question));
  if (latest?.status === 'waiting') return 'setup:' + latest.id;
}
/** A question may summon the window once; subsequent animation/progress updates never steal focus again. */
export class AttentionController {
  private shown = new Set<string>();
  take(active: ActiveRun | null, latest?: Run) {
    const key = attentionKey(active, latest);
    if (!key || this.shown.has(key)) return;
    this.shown.add(key);
    if (this.shown.size > 64) this.shown.delete(this.shown.values().next().value!);
    return key;
  }
}
