#!/usr/bin/env node
import {existsSync, readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';

const onPath = spawnSync('/usr/bin/which',['tailscale'],{encoding:'utf8',timeout:5000}).stdout?.trim();
const cli = [onPath,'/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(path => path && existsSync(path));
const firstLogin = 'Open Tailscale on this Mac, sign in, and approve its VPN/network extension in macOS. Sign in to the same account on Android, then run this helper again.';
if (!cli) { console.error(`Install Tailscale for macOS first. ${firstLogin}`); process.exit(1); }
const status = spawnSync(cli,['status','--json'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
let network;
try { if (status.status !== 0) throw new Error(); network = JSON.parse(status.stdout); }
catch { console.error(firstLogin); process.exit(1); }
if (network.BackendState !== 'Running' || !network.Self?.DNSName || network.Self.Online === false) { console.error(firstLogin); process.exit(1); }
const dnsName = network.Self.DNSName.trim().replace(/\.$/,'');
if (!/^[a-z0-9.-]+\.ts\.net$/i.test(dnsName)) { console.error('Tailscale did not return a private .ts.net address. Check MagicDNS in your tailnet settings.'); process.exit(1); }
const data = process.env.POCKETBRIDGE_DATA_DIR || join(homedir(),'Library/Application Support/PocketBridge');
mkdirSync(data,{recursive:true,mode:0o700});
const configFile = join(data,'config.json');
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile,'utf8')) : {};
const port = Number(process.env.POCKETBRIDGE_PORT ?? config.port ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PocketBridge port must be between 1 and 65535');
const serve = spawnSync(cli,['serve','--bg',`http://127.0.0.1:${port}`],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
if (serve.status !== 0) {
  console.error('Tailscale Serve could not start. You may need to enable HTTPS/Serve in your tailnet settings.');
  console.error(serve.stderr?.trim() || serve.stdout?.trim() || serve.error?.message || 'Check Tailscale and retry.'); process.exit(1);
}
config.publicUrl = `https://${dnsName}`;
const temporary = `${configFile}.${process.pid}.tmp`;
writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flush:true});
renameSync(temporary,configFile);
console.log(`Private address saved: ${config.publicUrl}`);
console.log('Tailscale Serve is private to your tailnet. No Funnel was enabled.');
const target = `gui/${process.getuid()}/com.pocketbridge.mac`;
if (spawnSync('/bin/launchctl',['print',target],{stdio:'ignore',timeout:5000}).status === 0) {
  let canRestart = false;
  try {
    const base = `http://127.0.0.1:${port}`;
    const {token} = await (await fetch(`${base}/api/local-session`,{signal:AbortSignal.timeout(3000)})).json();
    const state = await (await fetch(`${base}/api/state`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000)})).json();
    canRestart = !state.chats.some(chat => ['running','waiting','stopping'].includes(chat.status));
  } catch { /* Leave the saved configuration intact when the current service cannot be checked. */ }
  if (canRestart) {
    const restart = spawnSync('/bin/launchctl',['kickstart','-k',target],{encoding:'utf8',timeout:10000});
    if (restart.status === 0) console.log('PocketBridge restarted. Open Connect phone in the Mac client and create a pairing code.');
    else console.log('The address is saved. Restart PocketBridge, then create a pairing code.');
  } else console.log('The address is saved. Finish any active tasks, then restart PocketBridge and create a pairing code.');
} else console.log('Restart PocketBridge, then open Connect phone and create a pairing code.');
