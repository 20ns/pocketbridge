#!/usr/bin/env node
import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const value = process.argv[2];
if (!value) { console.error('Usage: mac/scripts/configure-url.sh https://your-mac.your-tailnet.ts.net'); process.exit(1); }
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.endsWith('.ts.net')) {
  throw new Error('Use the private HTTPS .ts.net address printed by Tailscale Serve, without a path.');
}
const data = process.env.POCKETBRIDGE_DATA_DIR || join(homedir(),'Library/Application Support/PocketBridge');
mkdirSync(data,{recursive:true,mode:0o700});
const file = join(data,'config.json');
const config = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : {};
const temporary = `${file}.${process.pid}.tmp`;
writeFileSync(temporary,JSON.stringify({...config,publicUrl:url.origin},null,2)+'\n',{mode:0o600,flush:true});
renameSync(temporary,file);
console.log(`Private address saved: ${url.origin}`);
console.log('Restart PocketBridge, then create a new pairing code.');
