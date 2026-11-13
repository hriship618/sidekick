import { commandSchema, type ActiveRun, type Question } from './contracts.ts';
import { planCommand } from './workflow.ts';
import { matchLocalIntent } from './local-router.ts';
import type { Store } from './store.ts';
import { localPath, type createRegistry } from './tools.ts';
import { z } from 'zod';
import { runAgent, type AgentServices } from './agent.ts';
import { ExecutionPolicy } from './execution-policy.ts';

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
        id, command, settings, model, store: this.store, registry: this.registry, browser: agent.browser,
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

  private async runClose(command: string, name: string) {
    const started = performance.now();
    const id = this.store.start(command, 'running', `Finding ${name}…`, [], `Close ${name}.`);
    const execution: Execution = { id, cancelling: false, controller: new AbortController() };
    this.execution = execution;
    this.publish();
    const call = async (label: string, operation: Parameters<typeof this.registry.desktop.run>[0]) => {
      execution.phase = label;
      const step = this.store.addStep(id, label, 'desktop');
      this.publish();
      try {
        const result = await this.registry.desktop.run(operation, execution.controller.signal);
        this.store.updateStep(id, step, 'completed', result);
        return result.data;
      } catch (error) {
        this.store.updateStep(id, step, execution.cancelling ? 'skipped' : 'failed', undefined, explain(error));
        throw error;
      }
    };
    type Window = { windowId: string; processId: number; title: string; productName?: string; processName?: string };
    try {
      let data = await call(`Finding ${name}`, { operation: { action: 'listWindows', query: name } });
      let windows = data.windows as Window[];
      if (!windows.length) {
        const answer = await this.ask(execution, { kind: 'text', text: `I couldn't find a visible ${name} window. What window title should I look for?` });
        execution.controller.signal.throwIfAborted();
        data = await call('Finding the requested window', { operation: { action: 'listWindows', query: String(answer) } });
        windows = data.windows as Window[];
      }
      if (!windows.length) throw new Error('No matching visible window was found. Check the app is open and use its window title.');
      const exact = windows.filter(row => [row.productName, row.processName].some(value => value?.toLowerCase() === name.toLowerCase()));
      if (exact.length) windows = exact;
      let target = windows[0];
      if (windows.length > 1) {
        const shown = windows.slice(0, 6);
        const answer = await this.ask(execution, { kind: 'text', text: 'Which window should I close? Reply with a number or exact title.\n' + shown.map((row, i) => `${i + 1}. ${row.title.slice(0, 65)}`).join('\n') });
        execution.controller.signal.throwIfAborted();
        const choice = String(answer).trim();
        const matches = /^\d+$/.test(choice) ? [shown[Number(choice) - 1]].filter(Boolean) : windows.filter(row => row.title.toLowerCase() === choice.toLowerCase());
        if (matches.length !== 1) throw new Error('That did not identify one window. Use its exact title when you try again.');
        target = matches[0];
      }
      const result = await call(`Closing ${target.title}`, { operation: { action: 'closeWindow', windowId: target.windowId, processId: target.processId } });
      if (!result.windowClosed) {
        await this.ask(execution, { kind: 'text', text: `${target.title.slice(0, 100)} is still open. Resolve any save or close prompt in the app, then reply “done” to verify.` });
        execution.controller.signal.throwIfAborted();
        const checked = await call('Checking the window closed', { operation: { action: 'listWindows' } });
        if ((checked.windows as Window[]).some(row => row.windowId === target.windowId)) throw new Error('The window is still open. Its close or save prompt needs attention.');
      }
      this.store.finish(id, 'completed', `Closed ${target.title}.${result.processStillRunning ? ' Its background process may still be running.' : ''}`);
    } catch (error) {
      this.store.finish(id, execution.cancelling ? 'cancelled' : 'failed', execution.cancelling ? 'Stopped. A close request already sent to Windows may still finish.' : explain(error));
    } finally {
      this.store.trace(id, 'local-execution', { route: 'close-window', modelCalls: 0, durationMs: Math.round(performance.now() - started) });
      this.execution = undefined;
      this.publish();
    }
  }

  async run(value: unknown) {
    const command = commandSchema.parse(value);
    if (this.execution) throw new Error('A task is already running.');
    const route = matchLocalIntent(command);
    if (route?.node === 'Close-App' && this.agent?.fastDesktop && this.store.settings().desktopAccess) return this.runClose(command, route.parameters.app);
    const plan = route?.node === 'Open-Dir'
      ? { description: 'Open the requested local resource.', actions: [{ tool: 'openLocal' as const, label: 'Open local item', input: { path: route.parameters.path } }] }
      : route?.node === 'Volume-Up' && this.agent?.fastDesktop && this.store.settings().desktopAccess
        ? { description: 'Increase playback volume and verify the setting.', actions: [{ tool: 'desktop' as const, label: 'Increase volume', input: { operation: { action: 'increaseVolume' as const, amount: route.parameters.amount } } }] }
        : planCommand(command, this.store.settings());
    if (!plan) {
      if (this.agent) return this.runNatural(command, this.agent);
      this.store.start(command, 'failed', 'Describe a task or use an explicit open command.');
      this.publish();
      return;
    }
    const id = this.store.start(command, 'running', 'Sending actions to Windows…', plan.actions, plan.description, plan.routine);
    if (route) this.store.trace(id, 'local-route', { ...route, modelCalls: 0 });
    const execution: Execution = { id, cancelling: false, controller: new AbortController() };
    this.execution = execution;
    const policy = new ExecutionPolicy(command, question => this.ask(execution, question));
    let failures = 0;
    try {
      for (const [index, action] of plan.actions.entries()) {
        if (execution.cancelling) break;
        execution.phase = action.label;
        this.store.updateStep(id, index, 'running');
        this.publish();
        try {
          if (action.tool === 'openLocal') await policy.authorizeLocal(localPath.parse(action.input.path), Boolean(plan.routine));
          execution.controller.signal.throwIfAborted();
          const result = await this.registry[action.tool].run(action.input, execution.controller.signal);
          this.store.updateStep(id, index, 'completed', result);
        } catch (error) {
          if (execution.cancelling) { this.store.updateStep(id, index, 'skipped'); break; }
          failures++;
          this.store.updateStep(id, index, 'failed', undefined, explain(error));
        }
      }
      if (execution.cancelling) {
        this.store.finish(id, 'cancelled', 'Rove stopped the task. Anything already opened may still be open.');
      } else {
        this.store.finish(id, failures ? 'failed' : 'completed', failures
          ? `${failures} of ${plan.actions.length} actions couldn’t finish.`
          : route?.node === 'Volume-Up' ? 'Playback volume increased and its setting verified.' : 'All launch requests sent.');
      }
    } finally {
      this.execution = undefined;
      this.publish();
    }
  }
}
