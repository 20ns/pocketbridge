#!/usr/bin/env node
// How the phone reaches this Mac. By default Tailscale Funnel gives the Mac an internet address, so the phone needs no
// Tailscale or VPN. With --tailnet-only, Tailscale Serve keeps it inside your tailnet and the phone needs Tailscale too.
// Either way Tailscale forwards to the service's remote listener, which only paired phones can use.
import {existsSync, readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import net from 'node:net';

const onPath = spawnSync('/usr/bin/which',['tailscale'],{encoding:'utf8',timeout:5000}).stdout?.trim();
const cli = [onPath,'/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(path => path && existsSync(path));
const tailnetOnly = process.argv.includes('--tailnet-only');
const firstLogin = 'Open Tailscale on this Mac, sign in, and approve its network extension in macOS, then run this helper again.';
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
const configuredRemote = Number(process.env.POCKETBRIDGE_REMOTE_PORT ?? config.remotePort ?? 8789);
for (const value of [port, configuredRemote]) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('PocketBridge ports must be between 1 and 65535');
const site = `${dnsName}:443`, publicUrl = `https://${dnsName}`;
const stop = (message, code = 1) => { (code ? console.error : console.log)(message); process.exit(code); };

// What Tailscale serves at this address now. Funnel opens the whole address, so it waits until nothing else is served there.
const serving = () => {
  const result = spawnSync(cli,['serve','status','--json'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout.trim() || '{}'); } catch { return null; }
};
const before = serving();
if (!before) stop('Could not read what Tailscale serves on this Mac. Nothing was changed; check Tailscale and run this helper again.');
const others = Object.keys(before.Web?.[site]?.Handlers ?? {}).filter(path => path !== '/');
if (!tailnetOnly && others.length) stop(`Tailscale also serves ${others.join(', ')} at ${publicUrl}. Funnel would put that on the internet too. Remove it, or run this helper with --tailnet-only. Nothing was changed.`);

// The running service, read through its browser port. Not running is fine; anything unexpected leaves everything as it is.
const base = `http://127.0.0.1:${port}`;
const inspect = async () => {
  let session;
  try { session = await fetch(`${base}/api/local-session`,{signal:AbortSignal.timeout(5000)}); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
  const {token} = session.ok ? await session.json() : {};
  if (typeof token !== 'string' || !token) throw new Error('No local session');
  const reply = await fetch(`${base}/api/state`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
  const current = reply.ok ? await reply.json() : null;
  if (!Array.isArray(current?.chats) || !current.server || typeof current.server !== 'object') throw new Error('Unexpected state');
  return current;
};
let state;
try { state = await inspect(); } catch { stop('PocketBridge on this Mac didn\'t answer as expected. Nothing was changed; run this helper again.'); }

// Whether anything listens on a port: true, false, or null when that can't be told.
const listening = portNumber => new Promise(resolveCheck => {
  const socket = net.connect(portNumber,'127.0.0.1');
  socket.setTimeout(2000,() => { socket.destroy(); resolveCheck(null); });
  socket.once('connect',() => { socket.destroy(); resolveCheck(true); });
  socket.once('error',error => resolveCheck(error.code === 'ECONNREFUSED' ? false : null));
});
// Without a running service the phone port must be free, or Funnel could publish another app there.
if (!state && await listening(configuredRemote) !== false) stop(`Something else is using port ${configuredRemote}. Set another "remotePort" in ${configFile}, then run this helper again. Nothing was changed.`);

// The address is the only setting saved here; the phone port is whatever the service listens on.
if (config.publicUrl !== publicUrl) {
  config.publicUrl = publicUrl;
  const temporary = `${configFile}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flush:true}); renameSync(temporary,configFile);
}
// A service from before 0.10 has no phone port, and one started with another address refuses this one: it restarts,
// never while a chat is working. Tailscale's current forward keeps working with the restarted service, so nothing here
// can cut a phone off.
const current = value => value?.server?.publicUrl === publicUrl && 'remotePort' in value.server;
if (state && !current(state)) {
  const job = `gui/${process.getuid()}/${process.env.POCKETBRIDGE_LAUNCHD_LABEL || 'com.pocketbridge.mac'}`;
  if (state.chats.some(chat => ['running','waiting','stopping'].includes(chat.status))) stop('Address saved. Let the working chats finish, then run this helper again.',0);
  if (spawnSync('/bin/launchctl',['print',job],{stdio:'ignore',timeout:5000}).status !== 0) stop('Address saved. Restart PocketBridge, then run this helper again.',0);
  if (spawnSync('/bin/launchctl',['kickstart','-k',job],{stdio:'ignore',timeout:10000}).status !== 0) stop('PocketBridge could not restart. Restart it, then run this helper again.');
  state = null;
  for (const until = Date.now() + 30_000; !current(state); await new Promise(resolveWait => setTimeout(resolveWait,500))) {
    if (Date.now() > until) stop(`PocketBridge hasn't come back yet. Check ${join(data,'service-error.log')}, then run this helper again.`);
    state = await inspect().catch(() => null);
  }
  console.log('PocketBridge restarted.');
}

// A running service's own state proves its phone port.
const remotePort = state ? state.server.remotePort : configuredRemote;
if (state && !remotePort) stop(`PocketBridge couldn't open its phone port because another app holds it. Free port ${configuredRemote} or set another "remotePort" in ${configFile}, restart PocketBridge, then run this helper again.`);
const target = `http://127.0.0.1:${remotePort}`;

// The first Funnel may ask you to allow it for your tailnet and print a link to open; its output stays on screen.
const forward = spawnSync(cli,[tailnetOnly ? 'serve' : 'funnel','--bg',target],{stdio:'inherit',timeout:600_000});
if (forward.status !== 0) stop(tailnetOnly ? 'Tailscale Serve could not start. You may need to enable HTTPS in your tailnet settings.' : 'Tailscale Funnel could not start. Allow Funnel for this Mac when Tailscale asks, or run this helper again with --tailnet-only.');
// Tailscale must now forward this address to the phone port and nothing else, on the internet only with Funnel.
const exact = value => value?.Web?.[site]?.Handlers?.['/']?.Proxy === target && (tailnetOnly || Object.keys(value.Web[site].Handlers).length === 1) && (value.AllowFunnel?.[site] === true) !== tailnetOnly;
if (!exact(serving())) {
  if (tailnetOnly) stop('Tailscale did not take the new setup. Run "tailscale serve status" to see what it is doing, then run this helper again.');
  // Never leave the address public in a state nobody checked: back to tailnet only, confirmed.
  spawnSync(cli,['serve','--bg',target],{stdio:'ignore',timeout:20000});
  const fallback = serving();
  if (fallback && fallback.AllowFunnel?.[site] !== true) stop('Tailscale did not take the setup as expected, so Funnel is off again and the address is tailnet only. Run "tailscale serve status" to see what it serves, then run this helper again.');
  stop('Tailscale did not take the setup as expected and Funnel may still be on. Run "tailscale funnel status" now and turn it off with "tailscale funnel reset" if needed.');
}
console.log(`Phone address: ${publicUrl}`);
if (tailnetOnly) console.log('Tailnet only: your phone needs Tailscale, signed in to the same account. Funnel is off.');
else console.log('Your phone reaches this Mac from any network, with no Tailscale or VPN. Only phones you pair can use it; remove one in Connect phone on the Mac.');
console.log(state ? 'Paired phones keep working. To pair another, open Connect phone on the Mac.' : 'Start PocketBridge, then open Connect phone and create a pairing code.');
