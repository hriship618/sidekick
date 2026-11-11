import { commandSchema, type ActiveRun, type Question } from './contracts.ts';
import { planCommand } from './workflow.ts';
import type { Store } from './store.ts';
import { localPath, type createRegistry } from './tools.ts';
import { z } from 'zod';
import { runAgent, type AgentServices } from './agent.ts';

export function explain(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => [...issue.path, issue.message].join(' · ')).join(' ');
  }
  return error instanceof Error ? error.message : 'Unexpected error.';
}

type Execution = {
  id: string; cancelling: boolean; agent?: boolean; phase?: string; controller: AbortController;
  prompt?: { question: Question; resolve: (answer: boolean | string | undefined) => void };
};

export class Runner {
  private execution?: Execution;
  private readonly store: Store;
  private readonly registry: ReturnType<typeof createRegistry>;
  private readonly publish: () => void;
  private readonly agent?: AgentServices;

  constructor(store: Store, registry: ReturnType<typeof createRegistry>, publish: () => void, agent?: AgentServices) {
    this.store = store;
    this.registry = registry;
    this.publish = publish;
    this.agent = agent;
  }

  active(): ActiveRun | null {
    const execution = this.execution;
    if (!execution) return null;
    const { id, cancelling, prompt, agent, phase } = execution;
    return { id, cancelling, question: prompt?.question, agent, phase };
  }

  cancel(id: string) {
    const execution = this.execution;
    if (!execution || execution.id !== id || execution.cancelling) return;
    execution.cancelling = true;
    const prompt = execution.prompt;
    execution.prompt = undefined;
    execution.controller.abort();
    prompt?.resolve(undefined);
    this.publish();
  }

  answer(id: string, answer: boolean | string) {
    const execution = this.execution;
    if (!execution || execution.id !== id || !execution.prompt) return;
    const kind = execution.prompt.question.kind;
    if ((kind === 'text' && typeof answer !== 'string') || (kind !== 'text' && typeof answer !== 'boolean')) return;
    if (answer === false && kind !== 'approval') {
      this.cancel(id);
      return;
    }
    const prompt = execution.prompt;
    execution.prompt = undefined;
    if (execution.agent) this.store.trace(id, 'answer', { kind, answer });
    prompt.resolve(answer);
    this.publish();
  }

  private ask(execution: Execution, question: Question) {
    execution.controller.signal.throwIfAborted();
    if (execution.agent) this.store.trace(execution.id, 'question', { kind: question.kind,
      text: question.kind === 'local' ? undefined : question.text });
    return new Promise<boolean | string | undefined>(resolve => {
      execution.prompt = { question, resolve };
      this.publish();
    });
  }

  private async runNatural(command: string, agent: AgentServices) {
    if (!agent.configured()) {
      this.store.start(command, 'waiting', this.store.settings().connectionMode === 'chatgpt'
        ? 'Continue with ChatGPT in Settings and approve plan access.'
        : 'Add an OpenAI API key in Settings, then run the command again.',
        [], 'Connect a model for natural-language tasks.');
      this.publish();
      return;
    }
    const settings = this.store.settings();
    const id = this.store.start(command, 'running', 'Understanding your request…', [], 'Run a natural-language task.');
    const execution: Execution = { id, cancelling: false, agent: true, controller: new AbortController() };
    this.execution = execution;
    this.publish();
    try {
      const model = await agent.model(settings);
      const result = await runAgent({
        id, command, model, store: this.store, registry: this.registry, browser: agent.browser,
        signal: execution.controller.signal, publish: this.publish,
        phase: phase => { execution.phase = phase; this.publish(); },
        ask: question => this.ask(execution, question),
      });
      this.store.finish(id, result.status, result.message);
    } catch (error) {
      this.store.trace(id, 'stopped', { cancelled: execution.cancelling, message: execution.cancelling ? undefined : explain(error) });
      this.store.finish(id, execution.cancelling ? 'cancelled' : 'failed',
        execution.cancelling ? 'Stopped the task. Actions already handed off may still finish.' : explain(error));
    } finally {
      this.execution = undefined;
      this.publish();
    }
  }

  async run(value: unknown) {
    const command = commandSchema.parse(value);
    if (this.execution) throw new Error('A task is already running.');
    const plan = planCommand(command);
    if (!plan) {
      if (this.agent) return this.runNatural(command, this.agent);
      this.store.start(command, 'failed', 'Describe a task or use an explicit open command.');
      this.publish();
      return;
    }
    const id = this.store.start(command, 'running', 'Sending actions to Windows…', plan.actions, plan.description);
    const execution: Execution = { id, cancelling: false, controller: new AbortController() };
    this.execution = execution;
    let failures = 0;
    try {
      for (const [index, action] of plan.actions.entries()) {
        if (execution.cancelling) break;
        this.store.updateStep(id, index, 'running');
        this.publish();
        try {
          if (action.tool === 'openLocal') {
            const path = localPath.parse(action.input.path);
            const approved = await this.ask(execution, { kind: 'local', path });
            if (!approved || execution.cancelling) {
              this.store.updateStep(id, index, 'skipped');
              break;
            }
          }
          const result = await this.registry[action.tool].run(action.input);
          this.store.updateStep(id, index, 'completed', result);
        } catch (error) {
          failures++;
          this.store.updateStep(id, index, 'failed', undefined, explain(error));
        }
      }
      if (execution.cancelling) {
        this.store.finish(id, 'cancelled', 'Sidekick stopped the task. Anything already opened may still be open.');
      } else {
        this.store.finish(id, failures ? 'failed' : 'completed', failures
          ? `${failures} of ${plan.actions.length} actions couldn’t finish.`
          : 'All launch requests sent.');
      }
    } finally {
      this.execution = undefined;
      this.publish();
    }
  }
}


