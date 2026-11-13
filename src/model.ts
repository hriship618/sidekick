import OpenAI from 'openai';
import type { FunctionTool, Response, ResponseCreateParamsBase, ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses';

export type ToolDefinition = Omit<FunctionTool, 'type' | 'strict'>;
export type ToolCall = Extract<ResponseOutputItem, { type: 'function_call' }>;
type ReplayItem = Extract<ResponseOutputItem, { type: 'reasoning' | 'function_call' }>;
export type ModelTurn = { items: ReplayItem[]; calls: ToolCall[] };
export type Exchange = { items: ReplayItem[]; outputs: ResponseInput };
export type AgentModel = {
  decide(instructions: string, context: string, tools: ToolDefinition[], previous: Exchange | undefined, signal: AbortSignal): Promise<ModelTurn>;
};

export function providerError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return 'OpenAI rejected the API key. Replace it in Settings.';
    if (error.status === 403 || error.status === 404) return 'OpenAI denied access to this model. Check the model ID and your project permissions.';
    if (error.status === 429) return 'OpenAI rate limit or quota reached. Check project billing and limits, then try again.';
    if (error.status === 400) return 'OpenAI rejected the request. Check that the selected model supports Responses and function calling.';
  }
  return 'Could not reach OpenAI. Check your connection and try again.';
}

class ChatGPTStreamFailure extends Error {
  code: string;
  constructor(code: string) { super('ChatGPT plan request failed.'); this.code = code; }
}

function chatGPTError(error: unknown): string {
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  const code = error instanceof OpenAI.APIError || error instanceof ChatGPTStreamFailure ? error.code : undefined;
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) {
    return 'ChatGPT plan usage limit reached. Open Settings → Manage usage to review your limit.';
  }
  if (code === 'subscription_sharing_user_not_eligible') return 'This ChatGPT account or workspace is ineligible for plan usage in Rove.';
  if (status === 401 || code === 'subscription_sharing_invalid_user') return 'The ChatGPT connection was rejected. Continue with ChatGPT again in Settings.';
  if (status === 400 || code === 'subscription_sharing_unsupported_capability') return 'ChatGPT plan access rejected this request. Choose another available model in Settings.';
  if (status === 403 || status === 404) return 'ChatGPT denied plan access for this request. Check the account and model in Settings.';
  if (status === 503 || code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') {
    return 'ChatGPT plan usage is temporarily unavailable. Try again later.';
  }
  return 'The ChatGPT plan request did not complete. Try again or check Settings → Manage usage.';
}

function modelAdapter(getKey: (signal: AbortSignal) => Promise<string>, model: string, plan: boolean, testEndpoint?: string): AgentModel {
  return {
    async decide(instructions, context, tools, previous, signal) {
      const key = await getKey(signal);
      signal.throwIfAborted();
      const client = new OpenAI({
        apiKey: key, baseURL: testEndpoint ?? 'https://api.openai.com/v1', maxRetries: 0, timeout: 45_000, logLevel: 'off',
        organization: null, project: null,
      });
      const input: ResponseInput = [{ role: 'user', content: context }];
      if (previous) input.push(...previous.items, ...previous.outputs);
      const functions = tools.map(tool => ({ ...tool, type: 'function' as const, strict: false }));
      const request: ResponseCreateParamsBase = {
        model, instructions, input, store: false, include: ['reasoning.encrypted_content'],
        tools: plan ? [{ type: 'namespace', name: 'sidekick', description: 'Rove desktop task tools.', tools: functions }] : functions,
        tool_choice: 'required', parallel_tool_calls: false,
      };
      let response: Response | undefined;
      try {
        if (plan) {
          const events = await client.responses.create({ ...request, stream: true }, { signal });
          for await (const event of events) {
            if (event.type === 'response.completed') response = event.response;
            if (event.type === 'response.failed') throw new ChatGPTStreamFailure(event.response.error?.code ?? '');
            if (event.type === 'error') throw new ChatGPTStreamFailure(event.code ?? '');
          }
        } else {
          response = await client.responses.create({ ...request, max_output_tokens: 3000, stream: false }, { signal });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new Error(plan ? chatGPTError(error) : providerError(error));
      }
      if (!response || response.status !== 'completed') throw new Error(plan
        ? 'The ChatGPT response ended before completion. No action from that response was run.'
        : 'OpenAI did not return a completed response.');
      const calls = response.output.filter(item => item.type === 'function_call');
      if (!calls.length || (plan && calls.some(call => call.namespace && call.namespace !== 'sidekick'))) {
        throw new Error('The selected model did not return a usable Rove action. Try another model.');
      }
      return { items: response.output.filter(item => item.type === 'reasoning' || item.type === 'function_call'), calls };
    },
  };
}

export function openAIModel(key: string, model: string, testEndpoint?: string): AgentModel {
  return modelAdapter(async () => key, model, false, testEndpoint);
}

export function chatGPTModel(getToken: (signal: AbortSignal) => Promise<string>, model: string, testEndpoint?: string): AgentModel {
  return modelAdapter(getToken, model, true, testEndpoint);
}

export async function testModel(model: AgentModel) {
  const turn = await model.decide('Call connection_check once.', 'Test the Rove connection.', [{
    name: 'connection_check', description: 'Confirm that tool calling works.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }], undefined, new AbortController().signal);
  if (turn.calls.length !== 1 || turn.calls[0].name !== 'connection_check') throw new Error('The model did not complete the tool-call test.');
}


