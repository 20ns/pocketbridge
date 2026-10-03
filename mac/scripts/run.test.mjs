import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createService} from '../service/server.mjs';

test('startup wrapper applies saved settings, listens and closes cleanly', {timeout:20000}, async () => {
  const data = mkdtempSync(join(tmpdir(),'pocketbridge-startup-'));
  writeFileSync(join(data,'config.json'),JSON.stringify({keepAwake:false,publicUrl:'https://test.private.ts.net',port:1}));
  const child = spawn(process.execPath,[new URL('./run.mjs',import.meta.url).pathname], {
    env:{...process.env,POCKETBRIDGE_DATA_DIR:data,POCKETBRIDGE_PORT:'0',POCKETBRIDGE_PUBLIC_URL:'https://override.private.ts.net'},
    stdio:['ignore','pipe','pipe'],
  });
  const exited = once(child,'exit');
  try {
    const url = await new Promise((resolve,reject) => {
      let output = '';
      child.stdout.on('data',chunk => {
        output += chunk;
        const match = /PocketBridge listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]);
      });
      child.once('error',reject);
      child.once('exit',code => reject(new Error(`Service exited before listening: ${code}`)));
    });
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(),{ok:true,version:1});
    const {token} = await (await fetch(`${url}/api/local-session`)).json();
    const state = await (await fetch(`${url}/api/state`,{headers:{Authorization:`Bearer ${token}`}})).json();
    assert.equal(state.server.publicUrl,'https://override.private.ts.net');
    // Simulate upgrading a wrapper that predates the durable service-owner setting.
    const db = new DatabaseSync(join(data,'data.sqlite'));
    db.prepare('DELETE FROM settings WHERE key=?').run('serviceOwner'); db.close();
    await assert.rejects(createService({port:0,dataDir:data,claudeAvailable:false}),/Stop the older service/);
    assert.equal((await fetch(`${url}/api/health`)).status,200);
    child.kill('SIGTERM');
    assert.deepEqual(await exited,[0,null]);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    rmSync(data,{recursive:true,force:true});
  }
});
