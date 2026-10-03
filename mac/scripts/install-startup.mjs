#!/usr/bin/env node
import {mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, renameSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';

if (process.platform !== 'darwin') throw new Error('Startup installation requires macOS');
const mac = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = ['/opt/homebrew/bin/node','/usr/local/bin/node'].find(path =>
  existsSync(path) && realpathSync(path) === realpathSync(process.execPath)) ?? process.execPath;
const label = 'com.pocketbridge.mac';
const data = process.env.POCKETBRIDGE_DATA_DIR || join(homedir(),'Library/Application Support/PocketBridge');
const agents = join(homedir(),'Library/LaunchAgents');
mkdirSync(agents,{recursive:true}); mkdirSync(data,{recursive:true,mode:0o700});
const plist = join(agents,`${label}.plist`);
const configPath = join(data,'config.json');
const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath,'utf8')) : {};
const claude = process.env.POCKETBRIDGE_CLAUDE_PATH || existing.claudePath || spawnSync('/usr/bin/which',['claude'],{encoding:'utf8'}).stdout.trim() || join(homedir(),'.local/bin/claude');
if (!existsSync(claude)) throw new Error('Claude Code was not found. Install and sign in to the official CLI first.');
// Codex is optional. launchd has no shell PATH, so its absolute location is recorded too.
const codex = process.env.POCKETBRIDGE_CODEX_PATH || existing.codexPath || spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'}).stdout.trim();
const temporary = `${configPath}.${process.pid}.tmp`;
writeFileSync(temporary,JSON.stringify({...existing,claudePath:claude,...(codex && existsSync(codex) ? {codexPath:codex} : {}),keepAwake:existing.keepAwake ?? true},null,2)+'\n',{mode:0o600,flush:true});
renameSync(temporary,configPath);
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const string = value => `<string>${escape(value)}</string>`;
const env = {PATH:`${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,POCKETBRIDGE_DATA_DIR:data};
writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${string(nodePath)}${string(join(mac,'scripts/run.mjs'))}</array>
<key>WorkingDirectory</key>${string(mac)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key,value])=>`<key>${key}</key>${string(value)}`).join('')}</dict>
<key>StandardOutPath</key>${string(join(data,'service.log'))}
<key>StandardErrorPath</key>${string(join(data,'service-error.log'))}
</dict></plist>\n`,{mode:0o600});
const domain = `gui/${process.getuid()}`;
spawnSync('/bin/launchctl',['bootout',domain,plist],{stdio:'ignore'});
const pidFile = join(data,'service.pid');
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile,'utf8'));
  if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    const command = spawnSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).stdout.trim();
    if (command.includes(join(mac,'scripts/run.mjs'))) {
      try { process.kill(pid,'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 60; attempt++) {
        try { process.kill(pid,0); await pause(100); } catch { break; }
      }
    }
  }
}
const result = spawnSync('/bin/launchctl',['bootstrap',domain,plist],{encoding:'utf8'});
if (result.status !== 0) throw new Error(result.stderr.trim() || 'launchctl could not install PocketBridge');
console.log(`PocketBridge starts at login. Settings remain in ${configPath}.`);
console.log('Open mac/launcher/PocketBridge.command to use the Mac client.');
