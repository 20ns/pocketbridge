#!/usr/bin/env node
import {mkdirSync, readFileSync, existsSync, statSync, renameSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';

const data = process.env.POCKETBRIDGE_DATA_DIR || join(homedir(), 'Library/Application Support/PocketBridge');
mkdirSync(data, {recursive:true,mode:0o700});
const configPath = join(data, 'config.json');
let config = {};
if (existsSync(configPath)) {
  try { config = JSON.parse(readFileSync(configPath,'utf8')); }
  catch (error) { console.error(`Invalid configuration at ${configPath}: ${error.message}`); process.exit(1); }
}
for (const [key,value] of Object.entries({
  POCKETBRIDGE_DATA_DIR:data,
  POCKETBRIDGE_PUBLIC_URL:config.publicUrl,
  POCKETBRIDGE_CLAUDE_PATH:config.claudePath,
  POCKETBRIDGE_CODEX_PATH:config.codexPath,
  POCKETBRIDGE_PORT:config.port,
})) if (value !== undefined && !process.env[key]) process.env[key] = String(value);

// ponytail: rotate on startup; ongoing service logging contains lifecycle errors, not chat events.
for (const name of ['service.log','service-error.log']) {
  const file = join(data,name);
  if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.previous`);
}
if (config.keepAwake !== false) {
  // -s prevents system sleep while connected to AC power. It does not defeat a closed lid.
  const awake = spawn('/usr/bin/caffeinate', ['-s','-w',String(process.pid)], {stdio:'ignore'});
  awake.on('error', error => console.error(`Keep-awake unavailable: ${error.message}`));
  process.on('exit', () => awake.kill());
}
const {createService} = await import('../service/server.mjs');
const service = await createService();
const pidFile = join(data,'service.pid');
writeFileSync(pidFile,String(process.pid),{mode:0o600});
process.on('exit', () => {
  if (existsSync(pidFile) && readFileSync(pidFile,'utf8') === String(process.pid)) rmSync(pidFile);
});
console.log(`PocketBridge listening on ${service.url}`);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
  await service.close(); process.exit(0);
});
