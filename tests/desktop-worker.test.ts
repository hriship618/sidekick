import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {DesktopWorker} from '../src/desktop-worker.ts';
import {DesktopExecutionError} from '../src/windows-desktop.ts';
test('persistent desktop helper serializes requests, survives errors, and restarts after cancellation',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const worker=new DesktopWorker(fileURLToPath(new URL('../src/windows-desktop.ps1',import.meta.url)));
 const run=(script:string)=>worker.execute({operation:{action:'runPowerShell',script,timeoutSeconds:5}});
 try{
  const results=await Promise.all([run('Write-Output 21'),run('Write-Output 42')]);
  assert.equal(String(results[0].data.output).trim(),'21');assert.equal(String(results[1].data.output).trim(),'42');
  await assert.rejects(run('throw "expected worker test error"'), error => {
    assert.ok(error instanceof DesktopExecutionError);
    assert.match(String(error.result.data.stderr), /expected worker test error/);
    assert.equal(error.result.data.exitCode, 1); return true;
  });
  assert.equal(String((await run('Write-Output 84')).data.output).trim(),'84');
  const controller=new AbortController();const pending=worker.execute({operation:{action:'runPowerShell',script:'Start-Sleep -Seconds 20',timeoutSeconds:25}},controller.signal);
  setTimeout(()=>controller.abort(),150);await assert.rejects(pending,/cancelled/);
  assert.equal(String((await run('Write-Output 168')).data.output).trim(),'168');
 }finally{worker.close();}
});
