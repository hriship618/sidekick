import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {_electron} from 'playwright';
const profile=await mkdtemp(join(tmpdir(),'rove-app-check-'));
let app;
try{
 const executablePath=process.env.ROVE_EXE;
 app=await _electron.launch({executablePath:executablePath??resolve('node_modules/electron/dist/electron.exe'),args:[...(executablePath?[]:['.']),'--user-data-dir='+profile],cwd:resolve('.'),env:{...process.env,ROVE_DISABLE_NOTIFICATIONS:'1'},timeout:30000});
 for(let i=0;i<100&&app.windows().length<2;i++)await new Promise(r=>setTimeout(r,100));
 let panel=app.windows().find(p=>!p.url().endsWith('#companion'));
 await panel.locator('input[aria-label=Command]').waitFor();
  const pageReady = async (companion, selector) => {
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      const page=app.windows().find(p=>!p.isClosed()&&p.url().endsWith('#companion')===companion);
      try{if(page&&await page.locator(selector).count()&&await page.locator(selector).first().isVisible())return page;}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('Recovered app window did not become ready.');
  };
 assert.equal(await app.evaluate(({app})=>app.getName()),'Rove');
 assert.equal(await panel.title(),'Rove');
 const setup=await panel.evaluate(()=>window.sidekick.snapshot());
 assert.equal(setup.chatgpt.connected,false,'disposable profile has no user credentials');
 // Wait for helper warmup separately so the recorded command measures a warm local path.
 await panel.waitForTimeout(1500);
 const title='RoveSmoke'+Date.now();
 await app.evaluate(async({BrowserWindow},title)=>{
  const fixture=new BrowserWindow({title,width:250,height:100,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  fixture.on('page-title-updated',event=>event.preventDefault());
  await fixture.loadURL('data:text/html,<body>Disposable Rove test</body>');fixture.showInactive();globalThis.testFixture=fixture;
 },title);
 const start=performance.now();
 await panel.evaluate(command=>window.sidekick.run(command),'close '+title);
 const elapsedMs=Math.round(performance.now()-start);
 const closed=await panel.evaluate(()=>window.sidekick.snapshot());
  console.log('local command finished',elapsedMs);
 assert.equal(closed.runs[0].status,'completed',closed.runs[0].message);
 assert.equal(closed.runs[0].steps.length,2);
 assert.equal(closed.runs[0].engine.modelCalls,0);
 await panel.evaluate(()=>window.sidekick.show('task'));
 await panel.getByText('Execution details',{exact:true}).click();
 assert.match(await panel.getByLabel('Execution engine metrics').innerText(),/Executed locally.*0 model calls/);
 assert.equal(await app.evaluate(()=>globalThis.testFixture.isDestroyed()),true);
 // A real local clarification must summon the hidden launcher once and focus its chat composer.
 const missing='RoveMissingApp'+Date.now();
 const waiting=panel.evaluate(command=>window.sidekick.run(command),'open '+missing);
 for(let i=0;i<100;i++){if((await panel.evaluate(()=>window.sidekick.snapshot())).active)break;await new Promise(r=>setTimeout(r,10));}
 await panel.evaluate(()=>window.sidekick.hide());
 for(let i=0;i<300;i++){if((await panel.evaluate(()=>window.sidekick.snapshot())).active?.question)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove').isVisible()),false,'an incoming question must not force open a dismissed chat');
 await panel.evaluate(()=>window.sidekick.show('task'));
 await panel.getByLabel('Your answer').waitFor({state:'visible',timeout:20000});
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove').isVisible()),true);
 assert.equal(await panel.getByLabel('Your answer').evaluate(element=>element===document.activeElement),true);
 if(process.env.ROVE_CHAT_SCREENSHOT)await panel.screenshot({path:process.env.ROVE_CHAT_SCREENSHOT});
 await panel.keyboard.press('Escape');
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove').isVisible()),false);
 assert.ok((await panel.evaluate(()=>window.sidekick.snapshot())).active.question,'Escape does not cancel the question');
 await panel.evaluate(()=>window.sidekick.show('task'));
 await panel.getByLabel('Your answer').fill('RoveStillMissing'+Date.now());
 await panel.getByRole('button',{name:'Send',exact:true}).click();
 await waiting;
 const answered=await panel.evaluate(()=>window.sidekick.snapshot());
 assert.equal(answered.runs[0].messages.length,4);
 assert.equal(await panel.getByRole('log',{name:'Conversation'}).locator('.chat-message.user').count(),2);
 assert.equal(await panel.getByLabel('Message Rove').isVisible(),true);
 console.log('quiet incoming question, reply focus, Escape and persisted chat verified');
 const followTitle='RoveFollowUpFixture'+Date.now();
 await app.evaluate(async({BrowserWindow},title)=>{
  const fixture=new BrowserWindow({title,width:240,height:100,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  fixture.on('page-title-updated',event=>event.preventDefault());await fixture.loadURL('data:text/html,<body>Follow-up fixture</body>');fixture.showInactive();globalThis.followFixture=fixture;
 },followTitle);
 await panel.getByLabel('Message Rove').fill('close '+followTitle);
 await panel.getByRole('button',{name:'Send',exact:true}).click();
 for(let i=0;i<200;i++){const state=await panel.evaluate(()=>window.sidekick.snapshot());if(state.runs[0].command==='close '+followTitle&&state.runs[0].status==='completed')break;await new Promise(r=>setTimeout(r,25));}
 // WM_CLOSE can hide a window before Electron has destroyed its wrapper.
 await app.evaluate(async()=>{for(let i=0;i<40&&!globalThis.followFixture.isDestroyed();i++)await new Promise(r=>setTimeout(r,25));});
 assert.equal(await app.evaluate(()=>globalThis.followFixture.isDestroyed()),true);
 const followed=await panel.evaluate(()=>window.sidekick.snapshot());
 assert.equal(followed.runs[0].messages.length,6,'follow-up keeps prior conversation');
 console.log('chat follow-up executed and retained the thread');
 await panel.evaluate(()=>window.sidekick.show('command'));
  console.log('launcher shown');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove').hide());
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove companion').isVisible()),true,'hiding launcher directly restores companion');
  console.log('companion restored after hide');
  await app.evaluate(({BrowserWindow})=>{const pid=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove companion').webContents.getOSProcessId();if(pid<=0||pid===process.pid)throw new Error('Invalid test renderer PID');process.kill(pid);});
  console.log('companion crash requested');
  await pageReady(true,'[data-creature]');
 assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove companion').webContents.isLoading()===false));
 const old=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove companion');const id=w.id;w.destroy();return id;});
 for(let i=0;i<100;i++){if(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Rove companion'&&w.id!==id),old))break;await panel.waitForTimeout(100);}
 assert.equal(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Rove companion'&&w.id!==id),old),true,'closed companion window is recreated');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove').show());
  panel=await pageReady(false,'input[aria-label=Command]');
  const mainBefore=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Rove');const pid=w.webContents.getOSProcessId();if(pid<=0||pid===process.pid)throw new Error('Invalid test renderer PID');process.kill(pid);return w.id;});
  for(let i=0;i<200;i++){if(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Rove'&&w.id!==id),mainBefore))break;await new Promise(r=>setTimeout(r,100));}
  panel=await pageReady(false,'input[aria-label=Command]');
  assert.equal(await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Rove'&&w.id!==id),mainBefore),true,'failed launcher window is replaced');
 const log=await readFile(join(profile,'logs','lifecycle.log'),'utf8');
  assert.ok((log.includes('renderer-gone')||log.includes('renderer-unresponsive'))&&log.includes('companion-closed'));
 const greetingTimes=[];
 for(let i=0;i<20;i++){
  const start=performance.now();
  if(i===0)await panel.evaluate(()=>window.sidekick.run('hi'));
  else await panel.evaluate(async()=>{const s=await window.sidekick.snapshot();await window.sidekick.followUp(s.runs[0].id,'hi');});
  greetingTimes.push(performance.now()-start);
  const state=await panel.evaluate(()=>window.sidekick.snapshot());assert.equal(state.runs[0].engine.modelCalls,0);assert.equal(state.runs[0].steps.length,0);assert.equal(state.runs[0].status,'completed');
 }
 greetingTimes.sort((a,b)=>a-b);
 await panel.getByRole('log',{name:'Conversation'}).getByText('Hey! What’s on your mind?',{exact:true}).first().waitFor();
 if(process.env.ROVE_TEXTING_SCREENSHOT)await panel.screenshot({path:process.env.ROVE_TEXTING_SCREENSHOT});
 const result={packaged:Boolean(executablePath),closeDurationMs:elapsedMs,greetingMedianMs:greetingTimes[9],greetingP95Ms:greetingTimes[18],greetingSamples:20,modelCalls:0,steps:2,rendererRecovery:true,companionRecovery:true};
 console.log(JSON.stringify(result));
 if(process.env.ROVE_RESULT)await writeFile(process.env.ROVE_RESULT,JSON.stringify(result,null,2));
}catch(error){
 if(app){
  const diagnostics=await app.evaluate(async({BrowserWindow})=>{
   const results=[];
   for(const w of BrowserWindow.getAllWindows())results.push({title:w.getTitle(),url:w.webContents.getURL(),crashed:w.webContents.isCrashed(),loading:w.webContents.isLoading(),visible:w.isVisible()});
   return results;
  });
  console.log(JSON.stringify(diagnostics));
 }
 console.log(await readFile(join(profile,'logs','lifecycle.log'),'utf8').catch(()=>''));throw error;
}finally{
 await app?.close();
 assert.ok(profile.startsWith(join(tmpdir(),'rove-app-check-')));
 await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
