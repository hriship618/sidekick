import { z } from 'zod';

export const defaultShortcut = 'Ctrl+Alt+Space';
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Super'];
export const shortcut = z.string().trim().max(45).transform((value, ctx) => {
  const parts = value.split('+').map(part => part.trim().toLowerCase());
  const key = parts.pop() ?? '';
  const ordered = modifiers.filter(modifier => parts.includes(modifier.toLowerCase()));
  if (!/^(?:[a-z0-9]|space|f(?:[1-9]|1[0-2]))$/.test(key) || !ordered.length || ordered.length !== parts.length) {
    ctx.addIssue({ code: 'custom', message: 'Use Ctrl, Alt, Shift or Super with a letter, digit, Space or F1–F12.' });
    return z.NEVER;
  }
  return [...ordered, key === 'space' ? 'Space' : key.toUpperCase()].join('+');
});

export const webUrl = z.string().trim().max(2048).refine(value => {
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname && !url.username && !url.password);
  } catch { return false; }
}, 'Enter an HTTP or HTTPS URL without embedded credentials.');

export const sshAlias = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 'Use the host alias from your SSH config.');
export const remoteDir = z.string().trim().max(512).regex(/^(?:\/|~\/)[a-zA-Z0-9_./ -]*$/, 'Use an absolute POSIX path or a path beginning with ~/ (letters, digits, spaces, dots, slashes, underscores and hyphens).');
export const localPath = z.string().trim().max(2048)
  .refine(value => /^[a-z]:\\[^:<>"|?*\x00-\x1f]*$/i.test(value), 'Enter an absolute local Windows drive path.');
export const routineSchema = z.strictObject({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  resources: z.array(z.union([webUrl, localPath])).max(12),
  sshAlias: z.union([sshAlias, z.literal('')]).default(''),
  remoteDir: z.union([remoteDir, z.literal('')]).default(''),
});
export const settingsSchema = z.strictObject({
  shortcut,
  showCompanion: z.boolean().default(true),
  animateCompanion: z.boolean().default(true),
  quietMode: z.boolean().default(false),
  desktopAccess: z.boolean().default(true),
  restingCorner: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).default('bottom-right'),
  restingPosition: z.strictObject({ displayId: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().default(null),
  routines: z.array(routineSchema).max(30).default([]),
  connectionMode: z.enum(['chatgpt', 'apiKey']).default('chatgpt'),
  chatgptModel: z.string().max(160).default(''),
  model: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/).default('gpt-5.6-terra'),
});

export const commandSchema = z.string().trim().min(1).max(4096);
export type SavedRoutine = z.infer<typeof routineSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = { shortcut: defaultShortcut, showCompanion: true, animateCompanion: true, model: 'gpt-5.6-terra', connectionMode: 'chatgpt', chatgptModel: '', quietMode: false, desktopAccess: true, restingCorner: 'bottom-right', restingPosition: null, routines: [] };

export type ToolResult = { verification: 'dispatch-only' | 'launcher-only' | 'browser-observed' | 'desktop-observed'; message: string; data?: Record<string, unknown> };
export type Step = {
  label: string; tool: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: ToolResult; error?: string;
};
export type Run = {
  id: string; command: string; createdAt: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  message: string; steps: Step[]; description?: string; routine?: string; finishedAt?: string;
  engine?: { modelCalls: number; graphPlans: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; usageReported: boolean; reducedChars: number };
  messages?: { id: number; role: 'user' | 'assistant'; text: string; at: string }[];
};
export const surfaceSchema = z.enum(['command', 'task', 'workspace']);
export type Surface = z.infer<typeof surfaceSchema>;
export type Question =
  | { kind: 'local'; path: string }
  | { kind: 'approval'; text: string; detail: string }
  | { kind: 'text'; text: string }
  | { kind: 'login'; text: string };
export type ActiveRun = { id: string; cancelling: boolean; question?: Question; questionId?: string; agent?: boolean; indeterminate?: boolean; phase?: string };
export type ChatGPTStatus = {
  busy: boolean; signingIn: boolean; connected: boolean; sharing: boolean; selectedId: string;
  profiles: { id: string; label: string; connected: boolean }[];
  models: { slug: string; name: string }[]; notice: string; welcome: boolean;
};
export type ChatGPTAction = { action: 'signIn' | 'addAccount' | 'cancel' | 'signOut' | 'refresh' | 'test' | 'usage' | 'dismiss' }
  | { action: 'select'; id: string };
export type CompanionState = { x: number; y: number; fromX: number; fromY: number; sequence: number; moving: boolean; viewX?: number; viewY?: number; areaWidth?: number; areaHeight?: number; tucked?: boolean; hovered?: boolean; dragging?: boolean; dockRevision?: number };
export type Snapshot = {
  settings: Settings; runs: Run[]; shortcutWarning: string; surface: Surface;
  active: ActiveRun | null; credentialSaved: boolean; chatgpt: ChatGPTStatus; companion: CompanionState;
};
export interface RoveApi {
  heartbeat(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  companionLayout(regions: { x: number; y: number; width: number; height: number }[]): Promise<void>;
  companionHit(interactive: boolean): Promise<void>;
  moveCompanion(position: { x: number; y: number; dragging?: boolean }): Promise<void>;
  grabCompanion(pointer: { x: number; y: number }): Promise<boolean>;
  launcherPosition(x: number): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  run(command: string): Promise<void>;
    followUp(id: string, command: string): Promise<void>;
  hide(): Promise<void>;
  show(surface: Surface): Promise<void>;
  cancel(id: string): Promise<void>;
  answer(id: string, answer: boolean | string): Promise<void>;
  credential(action: 'set' | 'paste' | 'clear' | 'test'): Promise<string>;
  openBrowser(): Promise<void>;
  chatgpt(action: ChatGPTAction): Promise<string>;
  onSummon(callback: () => void): () => void;
  onUpdate(callback: (snapshot: Snapshot) => void): () => void;
}
