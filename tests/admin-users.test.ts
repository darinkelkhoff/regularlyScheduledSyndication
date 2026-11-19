import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/d1.ts';
import { Authenticator } from './helpers/authenticator.ts';
import { AuthService } from '../src/auth/service.ts';
import { Catalog } from '../src/db/catalog.ts';
import { Subscriptions } from '../src/db/subscriptions.ts';
import { SourceVault } from '../src/security/source-vault.ts';
import type { Selection } from '../src/domain/selection.ts';
const browser='admin-report-browser';
async function setup(t: Parameters<typeof database>[0]) {
  const db=await database(t);let now=Date.parse('2026-10-27T12:00:00Z');
  const secret='administrator-setup-secret-at-least-32-characters';
  const auth=new AuthService(db,{origin:'http://localhost:8787',rpID:'localhost',rpName:'RegSched',setupSecret:secret},()=>now);
  const key=new Authenticator();const options=await auth.signupOptions('Administrator',browser,secret);
  const admin=await auth.register(options.challengeId,key.register(options.options.challenge),browser);
  return {db,auth,admin,key,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
test('admin report is bounded but global enabled counts include accounts beyond the table',async t=>{
  const {db,auth,admin}=await setup(t);
  await db.batch(Array.from({length:101},(_,i)=>db.prepare('INSERT INTO users(id,display_name,disabled,created_at) VALUES(?,?,?,?)').bind('person-'+i,'Person '+i,Number(i<5),Date.parse('2026-10-26T00:00:00Z')+i)));
  const report=await auth.adminUsers(admin.token);
  assert.equal(report.users.length,100);assert.equal(report.totalUsers,104);assert.equal(report.activeUsers,99);
  assert.equal(report.users[0]!.id,admin.user.id);
  await assert.rejects(auth.adminUsers('missing'),{message:'authentication_required'});
});
test('account dates survive logout and do not count re-verification as another sign-in',async t=>{
  const {auth,admin,key,advance,now,db}=await setup(t);
  let row=(await auth.adminUsers(admin.token)).users.find(u=>u.id===admin.user.id)!;
  assert.equal(row.createdAt,now());assert.equal(row.lastLoginAt,now());const created=row.createdAt;
  advance(10*60_000);const login=await auth.loginOptions(browser);const signed=await auth.login(login.challengeId,key.authenticate(login.options.challenge),browser);const last=now();
  advance(10*60_000);const verify=await auth.loginOptions(browser,signed.token);await auth.login(verify.challengeId,key.authenticate(verify.options.challenge),browser,signed.token);
  row=(await auth.adminUsers(signed.token)).users.find(u=>u.id===admin.user.id)!;assert.equal(row.lastLoginAt,last);assert.equal(row.createdAt,created);
  await auth.logout(signed.token);const stored=await db.prepare('SELECT created_at,last_login_at FROM users WHERE id=?').bind(admin.user.id).first();assert.equal(stored!.last_login_at,last);assert.equal(stored!.created_at,created);
  const later=now()+60_000;
  await db.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(later,admin.user.id).run();
  const recovery=await auth.recoveryOptions(admin.recoveryCode!,browser);const replacement=new Authenticator();
  const recovered=await auth.register(recovery.challengeId,replacement.register(recovery.options.challenge),browser);
  const after=(await auth.adminUsers(recovered.token)).users.find(u=>u.id===admin.user.id)!;
  assert.equal(after.lastLoginAt,later);assert.equal(after.createdAt,created);

});
test('active-feed counts match queued, paused, completed, waiting and episode-selection modes',async t=>{
  const {db,auth,admin}=await setup(t);const catalog=new Catalog(db,await SourceVault.create(new Uint8Array(32).fill(7)));const repository=new Subscriptions(db);let index=0;
  const cases:{selection:Selection;live?:boolean;paused?:boolean;complete?:boolean;expected:number}[]=[
    {selection:{mode:'all'},expected:1}, {selection:{mode:'all'},paused:true,expected:0},
    {selection:{mode:'all'},complete:true,expected:0},{selection:{mode:'all'},live:true,complete:true,expected:1},
    {selection:{mode:'choose',ids:[]},expected:0},{selection:{mode:'choose',ids:['one']},expected:1},
    {selection:{mode:'before',boundaryId:'one'},expected:0},{selection:{mode:'before',boundaryId:'two'},expected:1},
    {selection:{mode:'after',boundaryId:'one'},expected:1},{selection:{mode:'after',boundaryId:'two'},expected:0},
  ];
  for(const item of cases){const source=await catalog.addSource('alice','https://example.com/report-'+index++);await catalog.importEpisodes('alice',source,[{id:'one',title:'One',publishedAt:'2020-01-01T00:00:00Z'},{id:'two',title:'Two',publishedAt:'2020-01-02T00:00:00Z'}]);const id=await repository.create('alice',source,{schedule:{kind:'daily',hour:12,timeZone:'UTC'},selection:item.selection,live:!!item.live,choice:'now'},'2020-01-03T00:00:00Z');
    if(item.paused)await repository.change('alice',id,0,{kind:'pause'},'2020-01-03T00:00:00Z');
    if(item.complete){await repository.process('alice',id,0,'2020-01-03T00:00:00Z');await repository.process('alice',id,1,'2020-01-04T13:00:00Z');}
  }
  const report=await auth.adminUsers(admin.token);const alice=report.users.find(u=>u.id==='alice')!;
  assert.equal(alice.feedCount,cases.length);assert.equal(alice.activeFeedCount,cases.reduce((n,c)=>n+c.expected,0));assert.equal(alice.createdAt,null);assert.equal(alice.lastLoginAt,null);
  await db.prepare("UPDATE users SET disabled=1 WHERE id='alice'").run();assert.equal((await auth.adminUsers(admin.token)).users.find(u=>u.id==='alice')!.activeFeedCount,0);
});
