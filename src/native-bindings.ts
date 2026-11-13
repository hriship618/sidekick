import { createRequire } from 'node:module';
import { join } from 'node:path';
import type koffi from 'koffi';
let loaded: typeof koffi | undefined;
let attempted = false;
export function loadNative() {
  if (!attempted) {
    attempted = true;
    try { loaded = createRequire(typeof __filename !== 'undefined' ? __filename : join(process.cwd(), 'package.json'))('koffi') as typeof koffi; }
    catch { /* A native addon policy/ABI failure must never prevent the app opening. */ }
  }
  return loaded;
}
