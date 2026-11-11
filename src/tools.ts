import { z } from 'zod';
import { win32 } from 'node:path';
import { webUrl, sshAlias, remoteDir, type ToolResult } from './contracts.ts';

export const localPath = z.string().trim().max(2048)
  .refine(value => /^[a-z]:\\[^:<>"|?*\x00-\x1f]*$/i.test(value) && win32.isAbsolute(value),
    'Enter a local drive path such as C:\\Users\\you\\Documents.');

export interface PlatformTools {
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  launchTerminal(sshArgs: string[]): Promise<void>;
}

export function sshArguments(input: { alias: string; directory: string }) {
  const alias = sshAlias.parse(input.alias);
  const directory = remoteDir.parse(input.directory);
  const target = directory.startsWith('~/') ? `~/'${directory.slice(2)}'` : `'${directory}'`;
  // OpenSSH passes this fixed command to the remote user's shell.
  return ['-t', alias, `cd ${target} && exec /bin/sh -i`];
}

const output = z.strictObject({
  verification: z.enum(['dispatch-only', 'launcher-only']),
  message: z.string(),
});
function tool<S extends z.ZodType>(
  input: S, verification: ToolResult['verification'], execute: (input: z.output<S>) => Promise<string>,
) {
  return {
    input, output, verification, retryMayDuplicate: true,
    async run(value: unknown): Promise<ToolResult> {
      return output.parse({ verification, message: await execute(input.parse(value)) });
    },
  };
}

export function createRegistry(platform: PlatformTools) {
  return {
    openUrl: tool(z.strictObject({ url: webUrl }), 'dispatch-only', async ({ url }) => {
      await platform.openUrl(url);
      return 'Sent to the default browser. Page load is unverified.';
    }),
    openLocal: tool(z.strictObject({ path: localPath }), 'dispatch-only', async ({ path }) => {
      await platform.openPath(path);
      return 'Sent to Windows. The file or folder view is unverified.';
    }),
    sshWorkspace: tool(z.strictObject({ alias: sshAlias, directory: remoteDir }), 'launcher-only', async input => {
      await platform.launchTerminal(sshArguments(input));
      return 'Windows Terminal launcher started. SSH connection and directory are unverified.';
    }),
  };
}

type Registry = ReturnType<typeof createRegistry>;
export type Action = {
  [K in keyof Registry]: { tool: K; label: string; input: z.input<Registry[K]['input']> }
}[keyof Registry];



