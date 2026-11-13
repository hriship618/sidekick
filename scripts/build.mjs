import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await Promise.all([
  build({ entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' }, outdir: 'dist',
    outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', 'playwright', 'openai', 'oauth4webapi', 'koffi'], target: 'node24' }),
  build({ entryPoints: ['src/renderer.tsx'], outdir: 'dist', bundle: true,
    platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }),
]);
await copyFile('src/index.html', 'dist/index.html');

await copyFile('src/tray.png', 'dist/tray.png');

await copyFile('src/credential.ps1', 'dist/credential.ps1');
await copyFile('src/windows-desktop.ps1', 'dist/windows-desktop.ps1');
await copyFile('src/pointer.ps1', 'dist/pointer.ps1');

