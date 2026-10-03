import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('private setup saves settings with Serve and refuses an unsigned-in Mac', () => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-private-'));
  try {
    const bin = join(data,'bin'); mkdirSync(bin);
    writeFileSync(join(bin,'tailscale'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'status') console.log(JSON.stringify({BackendState:process.env.TEST_BACKEND,Self:{DNSName:'test.tailnet.ts.net.',Online:true}}));
else fs.writeFileSync(process.env.TEST_CALLS,JSON.stringify(process.argv.slice(2)));
`, {mode:0o700});
    writeFileSync(join(data,'config.json'),JSON.stringify({port:1,keepAwake:false,claudePath:'/preserve/me'}));
    linkSync(join(data,'config.json'),join(data,'previous-config.json'));
    const calls = join(data,'calls.json');
    const env = {...process.env,PATH:`${bin}:${process.env.PATH}`,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_PORT:'1',TEST_CALLS:calls};
    const script = new URL('./setup-private.mjs',import.meta.url).pathname;
    const refused = spawnSync(process.execPath,[script],{env:{...env,TEST_BACKEND:'NeedsLogin'},encoding:'utf8',timeout:15000});
    assert.equal(refused.status,1); assert.match(refused.stderr,/sign in/); assert.equal(existsSync(calls),false);
    const configured = spawnSync(process.execPath,[script],{env:{...env,TEST_BACKEND:'Running'},encoding:'utf8',timeout:15000});
    assert.equal(configured.status,0,configured.stderr);
    assert.deepEqual(JSON.parse(readFileSync(calls,'utf8')),['serve','--bg','http://127.0.0.1:1']);
    assert.deepEqual(JSON.parse(readFileSync(join(data,'config.json'),'utf8')), {port:1,keepAwake:false,claudePath:'/preserve/me',publicUrl:'https://test.tailnet.ts.net'});
    assert.deepEqual(JSON.parse(readFileSync(join(data,'previous-config.json'),'utf8')), {port:1,keepAwake:false,claudePath:'/preserve/me'});
    assert.equal(statSync(join(data,'config.json')).mode & 0o777,0o600);
  } finally { rmSync(data,{recursive:true,force:true}); }
});
