import type { Question } from './contracts.ts';

export type BrowserEffect = {
  effect: 'navigation' | 'edit' | 'submission' | 'destructive' | 'unknown';
  label: string; origin: string; destination?: string; review: boolean;
};
export class ExecutionPolicy {
  private stoppedAtReview = false;
  private readonly goal: string;
  private readonly answers: string[] = [];
  private readonly approved = new Set<string>();
  private readonly ask: (question: Question) => Promise<string | boolean | undefined>;

  constructor(goal: string, ask: (question: Question) => Promise<string | boolean | undefined>) {
    this.goal = goal;
    this.ask = ask;
  }

  rememberAnswer(answer: string) { this.answers.push(answer); }
  constraints() {
    const text = [this.goal, ...this.answers].join('\n');
    return {
      boundaryReached: this.stoppedAtReview,
      stopAtReview: /(?:stop|pause|wait|halt).{0,35}\b(?:review|summary|confirmation)\b|do(?:n['’]t| not)\s+(?:submit|send|confirm|pay|purchase)/i.test(text),
    };
  }

  observedReview(review: boolean) {
    if (review && this.constraints().stopAtReview) this.stoppedAtReview = true;
  }
  beforeAction(name: string) {
    if (this.stoppedAtReview && !['inspect', 'screenshot'].includes(name)) {
      throw new Error('Stopped at your review boundary. Review is ready and no further changes were made.');
    }
  }

  async authorize(effect: BrowserEffect): Promise<void> {
    const text = [this.goal, ...this.answers].join('\n');
    if (this.constraints().stopAtReview && (effect.review || effect.effect === 'submission' || effect.effect === 'destructive')) {
      this.stoppedAtReview = true;
      throw new Error('Stopped at your review boundary. The final action was not performed.');
    }
    if (effect.effect === 'navigation' || effect.effect === 'edit') return;
    const label = effect.label.toLowerCase();
    const negative = /\b(?:do not|don't|don’t|never|without)\s+(?:delete|remove|cancel|submit|send|pay|buy|publish|save)/i.test(text);
    const operation = /pay|buy|purchase|order|donate/i.test(label) ? /\b(?:pay|buy|purchase|place (?:the |an? )?order|donate)\b/i
      : /book/i.test(label) ? /\b(?:book|confirm (?:the )?booking)\b/i
        : /send|publish|post/i.test(label) ? /\b(?:send|publish|post)\b/i
          : /save/i.test(label) ? /\b(?:save)\b/i
            : effect.effect === 'destructive' ? /\b(?:delete|remove|cancel (?:the |my )?(?:order|booking|subscription))\b/i
              : /\bsubmit\b/i;
    const explicitlyRequested = effect.effect !== 'unknown' && !negative && operation.test(text);
    if (explicitlyRequested) return;
    const key = JSON.stringify([effect.effect, effect.origin, effect.destination, effect.label]);
    if (this.approved.has(key)) return;
    const granted = await this.ask({
      kind: 'approval',
      text: effect.effect === 'submission' ? 'Complete this final action?' : effect.effect === 'destructive' ? 'Allow this change?' : 'Allow this page action?',
      detail: `${effect.label} on ${effect.origin}\n${effect.effect === 'unknown'
        ? 'This control’s effect could not be verified as navigation or form editing.'
        : 'This changes data or sends information beyond preparing the task.'}`,
    });
    if (granted !== true) throw new Error('The user declined this action. Continue with the rest of the authorized task.');
    this.approved.add(key);
  }

  async authorizeLocal(path: string, configured = false): Promise<void> {
    if (configured) return;
    if (!/\.(?:exe|msi|ps1|bat|cmd|lnk|url|scr|vbs|js|hta|reg)$/i.test(path)) return;
    if (/\b(?:run|execute|install|launch)\b/i.test(this.goal) && this.goal.toLowerCase().includes(path.toLowerCase())) return;
    const key = 'execute:' + path.toLowerCase();
    if (this.approved.has(key)) return;
    if (!await this.ask({ kind: 'approval', text: 'Run this local item?', detail: `${path}\nThis file can execute code through Windows.` })) {
      throw new Error('The user declined running this item.');
    }
    this.approved.add(key);
  }
}
