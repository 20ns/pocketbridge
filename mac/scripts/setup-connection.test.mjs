import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn, spawnSync} from 'node:child_process';

const script = new URL('./setup-connection.mjs',import.meta.url).pathname;
// A stand-in Tailscale CLI: it records the forward it was asked for and reports it back as `serve status --json`.
function fakeTailscale(data) {
  const bin = join(data,'bin'); mkdirSync(bin);
  writeFileSync(join(bin,'tailscale'), `#!${process.execPath}
const fs = require('node:fs'), site = 'test.tailnet.ts.net:443', [command, ...rest] = process.argv.slice(2);
if (command === 'status') console.log(JSON.stringify({BackendState:process.env.TEST_BACKEND,Self:{DNSName:'test.tailnet.ts.net.',Online:true}}));
else if (command === 'serve' && rest[0] === 'status') {
  const call = fs.existsSync(process.env.TEST_CALLS) && !process.env.TEST_IGNORED ? JSON.parse(fs.readFileSync(process.env.TEST_CALLS,'utf8')) : null;
  const handlers = {...(call ? {'/':{Proxy:call.at(-1)}} : {}),...(process.env.TEST_OTHER ? {'/admin':{Proxy:'http://127.0.0.1:3000'}} : {})};
  console.log(JSON.stringify(Object.keys(handlers).length ? {Web:{[site]:{Handlers:handlers}},...(call?.[0] === 'funnel' ? {AllowFunnel:{[site]:true}} : {})} : {}));
} else fs.writeFileSync(process.env.TEST_CALLS,JSON.stringify(process.argv.slice(2)));
`, {mode:0o700});
  return bin;
}
// A port nothing listens on, for a service that isn't running.
const freePort = () => new Promise(resolvePort => { const server = net.createServer().listen(0,'127.0.0.1',() => { const {port} = server.address(); server.close(() => resolvePort(port)); }); });
const setup = (env, args = []) => new Promise(resolveRun => {
  const child = spawn(process.execPath,[script,...args],{env});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.on('close', status => resolveRun({status, stdout, stderr}));
});

test('connection setup turns on Funnel to the phone port, saves the address and refuses an unsigned-in Mac', async () => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-setup-'));
  try {
    const bin = fakeTailscale(data), calls = join(data,'calls.json');
    const port = await freePort();
    writeFileSync(join(data,'config.json'),JSON.stringify({port,keepAwake:false,claudePath:'/preserve/me'}));
    linkSync(join(data,'config.json'),join(data,'previous-config.json'));
    const env = {...process.env,PATH:`${bin}:${process.env.PATH}`,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_PORT:String(port),POCKETBRIDGE_REMOTE_PORT:'2',POCKETBRIDGE_LAUNCHD_LABEL:'com.pocketbridge.test-absent',TEST_CALLS:calls};
    const refused = spawnSync(process.execPath,[script],{env:{...env,TEST_BACKEND:'NeedsLogin'},encoding:'utf8',timeout:15000});
    assert.equal(refused.status,1); assert.match(refused.stderr,/sign in/); assert.equal(existsSync(calls),false);
    const configured = await setup({...env,TEST_BACKEND:'Running'});
    assert.equal(configured.status,0,configured.stderr);
    assert.deepEqual(JSON.parse(readFileSync(calls,'utf8')),['funnel','--bg','http://127.0.0.1:2']);
    assert.match(configured.stdout,/no Tailscale or VPN/);
    assert.deepEqual(JSON.parse(readFileSync(join(data,'config.json'),'utf8')), {port,keepAwake:false,claudePath:'/preserve/me',publicUrl:'https://test.tailnet.ts.net'});
    assert.deepEqual(JSON.parse(readFileSync(join(data,'previous-config.json'),'utf8')), {port,keepAwake:false,claudePath:'/preserve/me'});
    assert.equal(statSync(join(data,'config.json')).mode & 0o777,0o600);
    // Tailnet only keeps the address off the internet; a Tailscale that ignored the request is reported, not trusted.
    const tailnet = await setup({...env,TEST_BACKEND:'Running',POCKETBRIDGE_REMOTE_PORT:'9000'},['--tailnet-only']);
    assert.equal(tailnet.status,0,tailnet.stderr); assert.match(tailnet.stdout,/Funnel is off/);
    assert.deepEqual(JSON.parse(readFileSync(calls,'utf8')),['serve','--bg','http://127.0.0.1:9000']);
    // Funnel that can't be confirmed goes back to tailnet only.
    const ignored = await setup({...env,TEST_BACKEND:'Running',TEST_IGNORED:'1'});
    assert.equal(ignored.status,1); assert.match(ignored.stderr,/Funnel is off again/);
    assert.deepEqual(JSON.parse(readFileSync(calls,'utf8')),['serve','--bg','http://127.0.0.1:2']);
    // Funnel opens the whole address, so it waits while anything else is served there; tailnet only doesn't mind.
    rmSync(calls);
    const shared = await setup({...env,TEST_BACKEND:'Running',TEST_OTHER:'1'});
    assert.equal(shared.status,1); assert.match(shared.stderr,/also serves \/admin/); assert.equal(existsSync(calls),false);
    assert.equal((await setup({...env,TEST_BACKEND:'Running',TEST_OTHER:'1'},['--tailnet-only'])).status,0);
  } finally { rmSync(data,{recursive:true,force:true}); }
});

// A running service as setup sees it through the browser port; server is what its state reports.
async function runningService(t, server) {
  const service = {status:'idle',server};
  const listener = http.createServer((request, response) => {
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify(request.url === '/api/local-session' ? {token:'local'} : {chats:[{status:service.status}],server:service.server}));
  });
  await new Promise(resolveListening => listener.listen(0,'127.0.0.1',resolveListening));
  t.after(() => listener.close());
  service.port = listener.address().port;
  return service;
}

test('connection setup leaves Tailscale alone while an older service is working, so the phone is not cut off', async t => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-setup-')); t.after(() => rmSync(data,{recursive:true,force:true}));
  // An older service has no phone port yet, so it needs a restart first.
  const older = await runningService(t,{publicUrl:'https://test.tailnet.ts.net'}); older.status = 'running';
  const bin = fakeTailscale(data), calls = join(data,'calls.json');
  const env = {...process.env,PATH:`${bin}:${process.env.PATH}`,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_PORT:String(older.port),POCKETBRIDGE_LAUNCHD_LABEL:'com.pocketbridge.test-absent',TEST_CALLS:calls,TEST_BACKEND:'Running'};
  const waiting = await setup(env);
  assert.equal(waiting.status,0,waiting.stderr); assert.match(waiting.stdout,/Let the working chats finish/);
  assert.equal(existsSync(calls),false);
  // Idle but started by hand: it waits for a restart, and Tailscale still isn't touched.
  older.status = 'idle';
  const idle = await setup(env);
  assert.equal(idle.status,0,idle.stderr); assert.match(idle.stdout,/Restart PocketBridge, then run this helper again/);
  assert.equal(existsSync(calls),false); assert.deepEqual(JSON.parse(readFileSync(join(data,'config.json'),'utf8')),{publicUrl:'https://test.tailnet.ts.net'});
});

test('connection setup forwards to the phone port the running service reports, and stops when it has none', async t => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-setup-')); t.after(() => rmSync(data,{recursive:true,force:true}));
  const service = await runningService(t,{publicUrl:'https://test.tailnet.ts.net',remotePort:4567});
  const bin = fakeTailscale(data), calls = join(data,'calls.json');
  const env = {...process.env,PATH:`${bin}:${process.env.PATH}`,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_PORT:String(service.port),POCKETBRIDGE_REMOTE_PORT:'9999',POCKETBRIDGE_LAUNCHD_LABEL:'com.pocketbridge.test-absent',TEST_CALLS:calls,TEST_BACKEND:'Running'};
  const done = await setup(env);
  assert.equal(done.status,0,done.stderr); assert.match(done.stdout,/Paired phones keep working/);
  assert.deepEqual(JSON.parse(readFileSync(calls,'utf8')),['funnel','--bg','http://127.0.0.1:4567']);
  // Another app held the phone port when the service started.
  rmSync(calls); service.server = {publicUrl:'https://test.tailnet.ts.net',remotePort:null};
  const blocked = await setup(env);
  assert.equal(blocked.status,1); assert.match(blocked.stderr,/couldn't open its phone port/); assert.equal(existsSync(calls),false);
});

test('connection setup never points Tailscale at a port another app holds or a service that does not answer', async t => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-setup-'));
  const other = http.createServer((request, response) => response.end('{"ok":true}'));
  const silent = http.createServer(() => {});
  for (const server of [other, silent]) await new Promise(resolveListening => server.listen(0,'127.0.0.1',resolveListening));
  t.after(() => { other.close(); silent.closeAllConnections(); silent.close(); rmSync(data,{recursive:true,force:true}); });
  const bin = fakeTailscale(data), calls = join(data,'calls.json');
  const env = {...process.env,PATH:`${bin}:${process.env.PATH}`,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_LAUNCHD_LABEL:'com.pocketbridge.test-absent',TEST_CALLS:calls,TEST_BACKEND:'Running'};
  // PocketBridge isn't running and another app answers on the phone port.
  const taken = await setup({...env,POCKETBRIDGE_PORT:String(await freePort()),POCKETBRIDGE_REMOTE_PORT:String(other.address().port)});
  assert.equal(taken.status,1); assert.match(taken.stderr,/Something else is using port/);
  // The service's port accepts the connection but never answers.
  const stuck = await setup({...env,POCKETBRIDGE_PORT:String(silent.address().port),POCKETBRIDGE_REMOTE_PORT:'2'});
  assert.equal(stuck.status,1); assert.match(stuck.stderr,/didn't answer as expected/);
  // Some other app on the browser port, answering JSON that isn't PocketBridge's.
  const stranger = await setup({...env,POCKETBRIDGE_PORT:String(other.address().port),POCKETBRIDGE_REMOTE_PORT:'2'});
  assert.equal(stranger.status,1); assert.match(stranger.stderr,/didn't answer as expected/);
  assert.equal(existsSync(calls),false); assert.equal(existsSync(join(data,'config.json')),false);
});
