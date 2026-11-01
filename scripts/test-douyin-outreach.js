const assert = require('assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const {createRuntime} = require('../src/main/services/douyinOutreach/runtime');
const {createStore} = require('../src/main/services/douyinOutreach/store');
const {validateTask} = require('../src/main/services/douyinOutreach/schema');
const {registerOutreachHandlers} = require('../src/main/services/douyinOutreach/bridge');
const account={id:'a',phone:'开发测试抖音2',pt:'抖音'};
const work={id:'w',platformWorkId:'123456789',url:'https://www.douyin.com/video/123456789'};
function task(id='t',items=[{actionId:'action1',action:'reply',target:{work,platformCommentId:'comment1'},text:'测试回复'}]) {return {taskId:id,type:'outreach_execute',data:{schemaVersion:1,outreachTaskId:id,executionToken:`token-${id}`,account,actionItems:items,clientId:'local-client'}};}
function memoryStore(initial) {let saved=initial||{version:1,tasks:{},outbox:{}};return {load:()=>JSON.parse(JSON.stringify(saved)),save:s=>{saved=JSON.parse(JSON.stringify(s));}};}
function runtime(store=memoryStore(),execute=async()=>({status:'success'}),extra={}) {return createRuntime({store,adapter:{capabilities:{reply:{supported:true,verified:true},follow:{supported:true,verified:true},message:{supported:true,verified:true},search:{supported:true,verified:true}},execute,read:async()=>({works:[]})},resolveAccount:async()=>account,...extra});}
async function main(){
 const {acquireAccountOperation,withAccountOperation}=require('../src/main/services/accountOperationLock');
 const lockAccount={phone:'lock-test',pt:'抖音'};const releaseLock=await acquireAccountOperation(lockAccount);const order=[];
 const low=acquireAccountOperation(lockAccount,0).then(release=>{order.push('read');release();});
 const high=acquireAccountOperation(lockAccount,1).then(release=>{order.push('publish');release();});
 releaseLock();await Promise.all([low,high]);assert.deepEqual(order,['publish','read']);
 await assert.rejects(withAccountOperation(lockAccount,async()=>{throw new Error('test-release');}));
 const free=await acquireAccountOperation(lockAccount);free();
 const auditEvents=[];
 let count=0;const r=runtime(undefined,async()=>{count++;return {status:'success'};},{audit:(event,detail)=>auditEvents.push({event,detail})});
 const first=await r.accept(task());assert.equal(first.items[0].status,'success');await r.accept(task());assert.equal(count,1);
 assert.equal(r.acknowledge({success:true}),false);assert.equal(r.pendingResults().length,1);
 assert.equal(r.acknowledge({domain:'outreach',committed:true,taskId:'t',outreachTaskId:'t',executionToken:'wrong'}),false);
 assert.equal(r.acknowledge({domain:'outreach',committed:true,taskId:'t',outreachTaskId:'t',executionToken:'token-t'}),true);
 assert.equal(r.pendingResults().length,0);
 for(const event of ['task.received','task.running','action.intent','action.result','task.finished','task.result_acknowledged'])assert.ok(auditEvents.some(row=>row.event===event));
 assert.ok(auditEvents.every(row=>row.detail.taskId==='t'&&!Object.hasOwn(row.detail,'executionToken')));
 assert.throws(()=>r.accept({...task(),data:{...task().data,executionToken:'changed'}}),/identity/);
 assert.throws(()=>validateTask({...task(),data:{...task().data,actionItems:[{...task().data.actionItems[0],target:{work:{...work,url:'https://evil.test/video/123456789'},platformCommentId:'c'}}]}}),/URL/);
 assert.throws(()=>validateTask({...task(),data:{...task().data,extraScript:'alert(1)'}}),/unknown fields/);
 const deps=[{actionId:'f',action:'follow',target:{work,platformUserId:'u'}},{actionId:'m',action:'message',target:{work,platformUserId:'u'},text:'你好',dependsOnActionId:'f'}];
 let calls=[];const dependent=runtime(undefined,async i=>{calls.push(i.action);return {status:'failed'};});
 const depResult=await dependent.accept(task('dependency',deps));assert.deepEqual(calls,['follow']);assert.equal(depResult.items[1].status,'blocked');
 const uncertain=runtime(undefined,async()=>{throw new Error('socket timeout after submit');});
 const unknown=await uncertain.accept(task('unknown'));assert.equal(unknown.error.code,'UNKNOWN');
 const stopped=await uncertain.accept(task('later',[{...task().data.actionItems[0],actionId:'a2'}]));assert.equal(stopped.error.code,'UNKNOWN');
 let release;const gate=new Promise(resolve=>{release=resolve;});let active=0,max=0;
 const serial=runtime(undefined,async()=>{active++;max=Math.max(max,active);await gate;active--;return {status:'success'};});
 const p1=serial.accept(task('s1'));const p2=serial.accept(task('s2',[{...task().data.actionItems[0],actionId:'a2'}]));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(serial.cancel('s2','token-s2'),true);release();await p1;const cancelled=await p2;assert.equal(cancelled.error.code,'CANCELLED');assert.equal(max,1);
 const persisted=memoryStore();const once=runtime(persisted);await once.accept(task('restart'));let replays=0;const recovered=runtime(persisted,async()=>{replays++;return {status:'success'};});await recovered.accept(task('restart'));assert.equal(replays,0);assert.equal(recovered.pendingResults().length,1);
 const interruptedTask=task('interrupted',deps);const state={version:1,tasks:{key:{task:interruptedTask,status:'RUNNING',events:[{event:'ACTION_INTENT',actionId:'f'}]}},outbox:{}};
 const interrupted=runtime(memoryStore(state));const result=interrupted.pendingResults()[0].data;assert.deepEqual(result.items.map(i=>i.status),['unknown','cancelled']);
 const unavailable=runtime(memoryStore(),undefined,{resolveAccount:async()=>null});assert.equal((await unavailable.accept(task('missing'))).error.code,'ACCOUNT_MISMATCH');
 const closed=runtime(memoryStore(),async()=>{throw new Error('must not call');},{adapter:require('../src/main/services/douyinOutreach/adapter').createProductionAdapter()});assert.equal((await closed.accept(task('disabled'))).items[0].status,'blocked');
 const methods=new Map();const ws={clientId:'c',serverUrl:'http://local',registerTaskHandler:(name,handler)=>methods.set(name,handler)};registerOutreachHandlers(ws,{store:memoryStore(),resolveAccount:async()=>account,adapter:{capabilities:{search:{supported:true,verified:true}},read:async()=>({works:[]})}});
 const read={taskId:'read',type:'outreach_search',data:{schemaVersion:1,outreachTaskId:'read',executionToken:'r',account,keywords:['装修']}};assert.deepEqual((await methods.get('outreach_search')(read)).works,[]);assert.equal(methods.size,5);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'outreach-ledger-'));const ledger=path.join(directory,'ledger.json');const disk=createStore(ledger);disk.save({version:1,tasks:{},outbox:{}});assert.equal(disk.load().version,1);fs.writeFileSync(ledger,'broken');assert.throws(()=>disk.load());fs.rmSync(directory,{recursive:true,force:true});
 console.log('PASS: outreach contract, deduplication, dependencies, account queue, cancellation, durable ACK, restart and blocked capabilities');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
