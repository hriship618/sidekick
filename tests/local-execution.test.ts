import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Store} from '../src/store.ts';
import {Runner} from '../src/runner.ts';
import {createRegistry} from '../src/tools.ts';
import {closeIntent} from '../src/workflow.ts';
import type {BrowserSession} from '../src/browser.ts';

test('only straightforward window-close requests take the local route',()=>{
 assert.equal(closeIntent('close codex'),'codex');
 assert.equal(closeIntent('Please close "Notepad".'),'Notepad');
 for(const request of ['close all apps','close Codex and open Chrome','close the account','close Notepad without saving','close this window','close Rove'])assert.equal(closeIntent(request),undefined);
});
test('simple close discovers product identity, verifies closure, and never constructs a model',async()=>{
 const store=new Store(':memory:');const calls:string[]=[];
 const runner=new Runner(store,createRegistry({openUrl:async()=>{},openPath:async()=>{},launchTerminal:async()=>{},desktop:async({operation})=>{
  calls.push(operation.action);
  if(operation.action==='listWindows')return{verification:'desktop-observed',message:'Observed.',data:{windows:[{windowId:'1',processId:2,title:'ChatGPT',productName:'Codex',processName:'ChatGPT'}]}};
  assert.equal(operation.action,'closeWindow');
  return{verification:'desktop-observed',message:'Closed.',data:{windowClosed:true,processStillRunning:true}};
 }}),()=>{}, {fastDesktop:true,configured:()=>false,model:async()=>{throw new Error('Model must not be used.');},browser:{} as BrowserSession});
 try{await runner.run('close codex');assert.deepEqual(calls,['listWindows','closeWindow']);assert.equal(store.recent()[0].status,'completed');assert.match(store.recent()[0].message,/background process/);assert.equal(store.recent()[0].steps.length,2);}finally{store.close();}
});
test('local close asks for a specific window and never chooses arbitrarily',async()=>{
 const store=new Store(':memory:');let closed='';let answering=false;
 const runner=new Runner(store,createRegistry({openUrl:async()=>{},openPath:async()=>{},launchTerminal:async()=>{},desktop:async({operation})=>{
  if(operation.action==='listWindows')return{verification:'desktop-observed',message:'Observed.',data:{windows:[{windowId:'11',processId:2,title:'First',productName:'Widget'},{windowId:'12',processId:3,title:'Second',productName:'Widget'}]}};
  if(operation.action==='closeWindow')closed=operation.windowId;
  return{verification:'desktop-observed',message:'Closed.',data:{windowClosed:true}};
 }}),()=>{const active=runner.active();if(active?.question&&!answering){answering=true;queueMicrotask(()=>runner.answer(active.id,'2'));}}, {fastDesktop:true,configured:()=>false,model:async()=>{throw new Error('Not needed');},browser:{} as BrowserSession});
 try{await runner.run('close Widget');assert.equal(closed,'12');assert.equal(store.recent()[0].status,'completed');}finally{store.close();}
});
test('history caching invalidates when steps and results change',()=>{
 const store=new Store(':memory:');try{const id=store.start('test','running','');const first=store.recent();assert.equal(store.recent(),first);store.addStep(id,'Read','desktop');assert.notEqual(store.recent(),first);store.finish(id,'completed','Done');assert.equal(store.recent()[0].status,'completed');}finally{store.close();}
});
