#!/usr/bin/env node
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('Startup removal requires macOS');
const plist = join(homedir(),'Library/LaunchAgents/com.pocketbridge.mac.plist');
spawnSync('/bin/launchctl',['bootout',`gui/${process.getuid()}`,plist],{stdio:'ignore'});
rmSync(plist,{force:true});
console.log('PocketBridge startup removed. Chats, pairing and settings remain saved.');
