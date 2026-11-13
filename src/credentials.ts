import { clipboard, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Store } from './store.ts';

export async function readKey(store: Store) {
  const encrypted = store.credential();
  if (!encrypted) throw new Error('Add an OpenAI API key in Settings.');
  try {
    return (await safeStorage.decryptStringAsync(encrypted)).result;
  } catch {
    throw new Error('Windows could not unlock the saved API key. Replace it in Settings.');
  }
}

export async function requestKey(store: Store) {
  if (process.platform !== 'win32' || !await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('OS-backed credential storage is unavailable. Rove cannot save an API key on this system.');
  }
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = await readFile(join(__dirname, 'credential.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const key = await new Promise<string>((resolve, reject) => {
    // Only the native masked dialog receives the key. Its private stdout pipe goes straight to main.
    const child = spawn(powershell, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let value = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      value += chunk;
      if (value.length > 1024) child.kill();
    });
    child.once('error', () => reject(new Error('Could not open the Windows credential dialog.')));
    child.once('close', code => code === 0 ? resolve(value.trim())
      : reject(new Error('The Windows credential dialog could not finish.')));
  });
  if (!key) return false;
  await saveKey(store, key);
  return true;
}

export async function pasteKey(store: Store) {
  const key = (await clipboard.readText()).trim();
  if (!key) throw new Error('Your clipboard is empty. Copy your OpenAI API key first.');
  await saveKey(store, key);
}

async function saveKey(store: Store, key: string) {
  if (process.platform !== 'win32' || !await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('Windows credential protection is unavailable. The API key was not saved.');
  }
  if (!/^sk-[A-Za-z0-9_-]{12,509}$/.test(key)) throw new Error('Copy a valid OpenAI API key beginning with sk- and try again.');
  try {
    store.saveCredential(await safeStorage.encryptStringAsync(key));
  } catch {
    throw new Error('Windows could not protect the API key. The key was not saved.');
  }
}

