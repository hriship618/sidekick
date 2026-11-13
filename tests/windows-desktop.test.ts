import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { desktopInput, executeDesktop } from '../src/windows-desktop.ts';
import { createRegistry } from '../src/tools.ts';

const helper = fileURLToPath(new URL('../src/windows-desktop.ps1', import.meta.url));
test('desktop inputs cannot smuggle commands into a window or process target', () => {
  for (const operation of [
    { action: 'closeWindow', windowId: '123;Stop-Process', processId: 123 },
    { action: 'stopProcess', processId: -1 },
    { action: 'runPowerShell', script: '', timeoutSeconds: 999 },
    { action: 'closeWindow', windowId: '123', processId: 123, force: true },
  ]) assert.equal(desktopInput.safeParse({ operation }).success, false);
});

test('native desktop tools inspect, fill, invoke and gracefully close a disposable Windows app', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const title = 'Rove desktop test ' + Date.now();
  const script = `Add-Type -AssemblyName PresentationFramework
Add-Type -Namespace Test -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h,int n); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr h,int n,int value);'
$form=New-Object Windows.Window
$form.ShowActivated=$false
$form.Add_SourceInitialized({$h=[Windows.Interop.WindowInteropHelper]::new($form).Handle;[void][Test.Native]::SetWindowLong($h,-20,([Test.Native]::GetWindowLong($h,-20) -bor 0x08000000))})
$form.Title='${title}'
$form.Width=300;$form.Height=200
$stack=New-Object Windows.Controls.StackPanel
$form.Content=$stack
$field=New-Object Windows.Controls.TextBox
$field.Focusable=$false
$field.IsTabStop=$false
$field.Add_PreviewKeyDown({param($sender,$eventArgs);$eventArgs.Handled=$true})
$field.Add_PreviewTextInput({param($sender,$eventArgs);$eventArgs.Handled=$true})
[Windows.Automation.AutomationProperties]::SetName($field,'Test field')
$button=New-Object Windows.Controls.Button
$button.Content='Test action'
$button.Add_Click({$form.Title='${title} invoked'})
[void]$stack.Children.Add($field)
[void]$stack.Children.Add($button)
$form.Add_ContentRendered({$h=[Windows.Interop.WindowInteropHelper]::new($form).Handle;[void][Test.Native]::ShowWindow($h,4);[Console]::WriteLine($h.ToInt64());[Console]::Out.Flush()})
[void]$form.ShowDialog()`;
  const fixture = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  try {
    const windowId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test window did not start.')), 12000);
      fixture.stdout.on('data', chunk => { buffer += chunk; if (/\d+\r?\n/.test(buffer)) { clearTimeout(timer); resolve(buffer.trim()); } });
      fixture.on('error', reject);
    });
    const registry = createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {}, desktop: (input, signal) => executeDesktop(helper, input, signal) });
    const run = (operation: unknown) => registry.desktop.run({ operation });
    const target = { windowId, processId: fixture.pid! };
    const listed = await run({ action: 'listWindows' });
    assert.ok((listed.data.windows as { windowId: string }[]).some(w => w.windowId === windowId), JSON.stringify({windowId, exit: fixture.exitCode, count: (listed.data.windows as unknown[]).length, matching: (listed.data.windows as {title:string}[]).filter(w=>w.title.includes('Rove desktop test'))}));
    const own = (listed.data.windows as { windowId: string; processName: string; productName: string }[]).find(w => w.windowId === windowId)!;
    assert.equal(own.processName.toLowerCase(), 'powershell');
    assert.ok(own.productName, 'executable product identity is observed');
    const byProduct = await run({ action: 'listWindows', query: own.productName.toUpperCase() });
    assert.ok((byProduct.data.windows as {windowId:string}[]).some(w => w.windowId === windowId), 'product identity matches despite an unrelated window title');
    const missing = await run({ action: 'listWindows', query: 'sidekick-window-that-does-not-exist-' + Date.now() });
    assert.deepEqual(missing.data.windows, []);
    await assert.rejects(run({ action: 'closeWindow', ...target, processId: fixture.pid! + 1 }), /no longer matches/);
    const inspected = await run({ action: 'inspectWindow', ...target });
    const controls = inspected.data.controls as { controlId: string; name: string }[];
    const field = controls.find(c => c.name === 'Test field');
    const button = controls.find(c => c.name === 'Test action');
    assert.ok(field && button, 'real accessibility controls were observed: ' + JSON.stringify(inspected.data));
    assert.equal((await run({ action: 'fillControl', ...target, controlId: field.controlId, value: 'hello $ literal; text' })).data.valueMatched, true);
    await run({ action: 'invokeControl', ...target, controlId: button.controlId });
    const after = await run({ action: 'listWindows' });
    assert.ok((after.data.windows as { title: string }[]).some(w => w.title === title + ' invoked'));
    const closed = await run({ action: 'closeWindow', ...target });
    assert.equal(closed.data.windowClosed, true);
    assert.equal(closed.verification, 'desktop-observed');
    const command = await run({ action: 'runPowerShell', script: 'Write-Output (6 * 7)', timeoutSeconds: 5 });
    assert.equal(String(command.data.output).trim(), '42');
    await assert.rejects(run({ action: 'runPowerShell', script: '& $env:ComSpec /d /c "exit 7"', timeoutSeconds: 5 }), /code 7/);
    assert.ok(Array.isArray((await run({ action: 'listProcesses', name: 'powershell' })).data.processes));
    const worker = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], { windowsHide: true, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
      assert.equal((await run({ action: 'stopProcess', processId: worker.pid! })).data.exited, true);
    } finally { worker.kill(); }
    const controller = new AbortController();
    const pending = executeDesktop(helper, { operation: { action: 'runPowerShell', script: 'Start-Sleep -Seconds 30', timeoutSeconds: 40 } }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, /cancelled/);
  } finally { fixture.kill(); }
});
