// Official CLI permission host and question hook. No Claude credentials cross this bridge.
import http from 'node:http';
import { createInterface } from 'node:readline';
// Not fetch: its headers timeout (300s) would deny a question nobody answered within five minutes, though the hook
// may wait a day. node:http with no agent applies no timeout; the request lasts until the Mac answers.
const post = (url, payload) => new Promise((resolvePost, reject) => {
  const data = JSON.stringify(payload);
  const request = http.request(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${process.env.POCKETBRIDGE_INTERNAL_TOKEN}` } }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('error', reject);
    response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(); resolvePost(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  request.on('error', reject); request.end(data);
});
async function decision(input) {
  try {
    return await post(`${process.env.POCKETBRIDGE_INTERNAL_URL}/internal/approval`, { chatId: process.env.POCKETBRIDGE_CHAT_ID, tool: input.tool_name, input: input.tool_input ?? input.input ?? {} });
  } catch { return { behavior: 'deny', message: 'Permission connection lost. Reconnect and send another prompt.' }; }
}
if (process.argv.includes('--hook')) {
  let data = ''; for await (const chunk of process.stdin) data += chunk;
  const answer = await decision(JSON.parse(data));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: answer.behavior,
    ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
    ...(answer.message ? { permissionDecisionReason: answer.message } : {}),
  } }));
} else {
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    if (request.method === 'initialize') send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pocketbridge', version: '1.0.0' } });
    else if (request.method === 'tools/list') send(request.id, { tools: [{ name: 'approve', description: 'Collect a permission decision from the PocketBridge user.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] });
    else if (request.method === 'tools/call') send(request.id, { content: [{ type: 'text', text: JSON.stringify(await decision(request.params.arguments)) }] });
    else if (request.method === 'ping') send(request.id, {});
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
  }
}
