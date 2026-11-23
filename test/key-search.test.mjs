import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backends, clearRefusal, createExtension, keyDigest, markRefused, nativeSearch, nativeSearchTools, readKey, readRefusal,
  refusalApplies, searchesNatively, searchWithKey,
} from '../extension.mjs';
import { converse, sse } from './pi.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = resolve(here, 'fixtures/key-search.mjs');
const syntheticKey = 'BSA-synthetic-test-key-0001';

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'pi-web-search-key-'));
  try { return await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function writeKey(home, key = { api_key: syntheticKey, backend: 'brave', source: 'own' }, mode = 0o600) {
  await mkdir(join(home, '.config/web-search'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, '.config/web-search/key.json'), typeof key === 'string' ? key : JSON.stringify(key), { mode });
  // Explicitly, since the umask and an existing file both keep `mode` from applying.
  await chmod(join(home, '.config/web-search/key.json'), mode);
}

// A synthetic Brave Web Search API answering every request with `reply`.
async function brave(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: new URL(req.url, 'http://x'), headers: req.headers });
    const [status, body] = reply(requests.length);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/res/v1/web/search`, close: () => server.close() };
}

const braveResults = { type: 'search', web: { type: 'search', results: [
  { title: 'Synthetic result', url: 'https://example.com/found', description: 'A synthetic description.', age: '2 days ago' },
  { title: 'Not a web link', url: 'javascript:alert(1)' },
] } };

test('the published native-search list is the one the extension uses', async () => {
  const published = JSON.parse(await readFile(resolve(here, '../native-search.json'), 'utf8'));
  assert.deepEqual(published, JSON.parse(JSON.stringify(nativeSearch)));
  const pkg = JSON.parse(await readFile(resolve(here, '../package.json'), 'utf8'));
  assert.ok(pkg.files.includes('native-search.json'));
  // Every listed provider with an API gets the provider's own tool here.
  for (const p of nativeSearch.providers.filter(p => p.api)) {
    assert.ok(nativeSearchTools({ ...p, id: 'm' }, { model: 'm', tools: [] }).length > 0, p.provider);
    assert.equal(searchesNatively({ ...p, id: 'm' }), true);
  }
  assert.equal(searchesNatively({ provider: 'claude-bridge', api: 'claude-bridge' }), true);
  for (const model of [{ provider: 'deepseek', api: 'openai-completions' }, { provider: 'openai', api: 'openai-completions' }, undefined]) {
    assert.equal(searchesNatively(model), false, JSON.stringify(model));
  }
});

test('the key is read only from the person\'s own private, well-formed file', () => withHome(async home => {
  assert.deepEqual(await readKey(home), { problem: 'missing' });
  await writeKey(home, { api_key: syntheticKey, backend: 'brave', source: 'site', set_at: '2026-11-23T00:00:00Z' });
  assert.deepEqual(await readKey(home), { key: { api_key: syntheticKey, backend: 'brave', source: 'site' } });
  await writeKey(home, undefined, 0o644);
  assert.deepEqual(await readKey(home), { problem: 'unsafe' }, 'a key others can read is not used');
  for (const bad of ['{', '[]', JSON.stringify({ api_key: syntheticKey, backend: 'google', source: 'own' }),
    JSON.stringify({ api_key: 'has space in it', backend: 'brave', source: 'own' }), JSON.stringify({ api_key: syntheticKey, backend: 'brave' })]) {
    await rm(join(home, '.config/web-search/key.json'));
    await writeKey(home, bad);
    assert.deepEqual(await readKey(home), { problem: 'invalid' }, bad);
  }
  await rm(join(home, '.config/web-search/key.json'));
  await writeFile(join(home, 'elsewhere.json'), JSON.stringify({ api_key: syntheticKey, backend: 'brave', source: 'own' }), { mode: 0o600 });
  await symlink(join(home, 'elsewhere.json'), join(home, '.config/web-search/key.json'));
  assert.deepEqual(await readKey(home), { problem: 'unsafe' }, 'a symlink is not followed');
}));

test('a Brave search sends the key only in its header and reads the results', async () => {
  const service = await brave(() => [200, braveResults]);
  try {
    const key = { api_key: syntheticKey, backend: 'brave', source: 'own' };
    const found = await searchWithKey(key, { query: 'synthetic query', count: 3, freshness: 'week' }, { endpoint: service.endpoint });
    assert.equal(found.outcome, 'ok');
    assert.deepEqual(found.results, [{ title: 'Synthetic result', url: 'https://example.com/found', description: 'A synthetic description.', age: '2 days ago' }]);
    const [request] = service.requests;
    assert.equal(request.headers['x-subscription-token'], syntheticKey);
    assert.equal(request.headers.accept, 'application/json');
    assert.ok(!request.url.href.includes(syntheticKey));
    assert.deepEqual(Object.fromEntries(request.url.searchParams), { q: 'synthetic query', count: '3', text_decorations: 'false', freshness: 'pw' });
    assert.equal(backends.brave.endpoint, 'https://api.search.brave.com/res/v1/web/search');
  } finally { service.close(); }
});

test('Brave\'s answers are told apart: refused key, limit, failure', async () => {
  const outcome = backends.brave.outcome.bind(backends.brave);
  assert.equal(outcome(200, {}), 'ok');
  assert.equal(outcome(401, {}), 'rejected');
  assert.equal(outcome(403, undefined), 'rejected');
  assert.equal(outcome(422, { type: 'ErrorResponse', error: { code: 'SUBSCRIPTION_TOKEN_INVALID', status: 422 } }), 'rejected');
  assert.equal(outcome(422, { error: { code: 'VALIDATION' } }), 'unavailable');
  assert.equal(outcome(429, {}), 'limit');
  assert.equal(outcome(402, {}), 'limit');
  assert.equal(outcome(500, {}), 'unavailable');
  assert.equal(outcome(302, undefined), 'unavailable');
  const key = { api_key: syntheticKey, backend: 'brave', source: 'own' };
  // A redirect is not followed: the key goes to Brave's address only.
  const redirecting = http.createServer((req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  await new Promise(r => redirecting.listen(0, '127.0.0.1', r));
  try {
    const found = await searchWithKey(key, { query: 'q' }, { endpoint: `http://127.0.0.1:${redirecting.address().port}/` });
    assert.deepEqual(found, { outcome: 'unavailable', status: 302, results: [] });
  } finally { redirecting.close(); }
  assert.equal((await searchWithKey(key, { query: 'q' }, { endpoint: 'http://127.0.0.1:1/' })).outcome, 'unavailable');
  assert.equal((await searchWithKey({ ...key, backend: 'staan' }, { query: 'q' })).outcome, 'unavailable', 'Staan is not enabled yet');
  assert.equal(backends.staan.enabled, false);
});

test('a refusal mark names its key by digest and only that key clears it', () => withHome(async home => {
  const key = { api_key: syntheticKey, backend: 'brave', source: 'own' };
  assert.equal(await markRefused(home, key, 401), false, 'no key directory, no mark');
  await writeKey(home);
  assert.equal(await markRefused(home, key, 401, new Date('2026-11-23T10:00:00Z')), true);
  const path = join(home, '.config/web-search/state.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const raw = await readFile(path, 'utf8');
  assert.ok(!raw.includes(syntheticKey));
  assert.deepEqual(JSON.parse(raw), { last_refused_at: '2026-11-23T10:00:00.000Z', backend: 'brave', status: 401, key_sha256: keyDigest(syntheticKey) });
  const mark = await readRefusal(home);
  assert.equal(refusalApplies(mark, key), true);
  const replaced = { ...key, api_key: 'BSA-synthetic-test-key-0002' };
  assert.equal(refusalApplies(mark, replaced), false, 'a new key starts clean');
  await clearRefusal(home, replaced);
  assert.ok(await readRefusal(home), 'another key does not clear the mark');
  await clearRefusal(home, key);
  assert.equal(await readRefusal(home), undefined);
}));

// DeepSeek through Pi's own provider: the first request calls web_search, the
// second answers with what the tool returned.
const completion = chunks => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const callsSearch = completion([
  { id: 'c1', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"synthetic query"}' } }] }, finish_reason: null }] },
  { id: 'c1', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
]);
const answers = completion([
  { id: 'c2', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'KEY-SEARCHED-ANSWER' }, finish_reason: null }] },
  { id: 'c2', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
]);
const declares = (body, name) => (body.tools ?? []).some(t => (t.function?.name ?? t.name) === name);
const toolResults = body => (body.messages ?? body.input ?? []).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

async function keyConversation({ setup, inspect, provider = 'deepseek', model = 'deepseek-flash', reply, braveReply = () => [200, braveResults], tools = 'read,web_search' }) {
  const service = await brave(braveReply);
  try {
    const result = await converse(provider, model, ['find it'], reply, [], {
      resource: fixture, tools, env: { PI_WEB_SEARCH_TEST_BRAVE: service.endpoint }, setup, inspect,
    });
    return { ...result, braveRequests: service.requests };
  } finally { service.close(); }
}

const searchThenAnswer = n => [200, n === 1 ? callsSearch : answers];

test('a model without search of its own searches with the key', async () => {
  // Without --tools, as a host starts Pi: the late-registered tool is active.
  const { bodies, out, braveRequests } = await keyConversation({ setup: home => writeKey(home), reply: searchThenAnswer, tools: null });
  assert.equal(bodies.length, 2, out);
  assert.ok(declares(bodies[0], 'web_search'), JSON.stringify(bodies[0].tools));
  assert.equal(braveRequests.length, 1);
  assert.equal(braveRequests[0].headers['x-subscription-token'], syntheticKey);
  assert.equal(braveRequests[0].url.searchParams.get('q'), 'synthetic query');
  const results = toolResults(bodies[1]).join('\n');
  assert.match(results, /Synthetic result/);
  assert.match(results, /https:\/\/example\.com\/found/);
  assert.doesNotMatch(results, /javascript:/);
  assert.match(out, /KEY-SEARCHED-ANSWER/);
});

test('a key the service refuses leaves a mark the host can read, and a later search clears it', async () => {
  let mark;
  const refused = await keyConversation({
    setup: home => writeKey(home), inspect: async home => { mark = await readRefusal(home); },
    reply: searchThenAnswer, braveReply: () => [401, { type: 'ErrorResponse', error: { code: 'UNAUTHORIZED', status: 401 } }],
  });
  assert.equal(refused.bodies.length, 2, refused.out);
  assert.match(toolResults(refused.bodies[1]).join('\n'), /Brave refused the search key \(HTTP 401\)/);
  assert.equal(mark?.status, 401);
  assert.equal(mark?.key_sha256, keyDigest(syntheticKey));
  let after = 'unread';
  await keyConversation({
    setup: async home => { await writeKey(home); await markRefused(home, { api_key: syntheticKey, backend: 'brave' }, 401); },
    inspect: async home => { after = await readRefusal(home); }, reply: searchThenAnswer,
  });
  assert.equal(after, undefined);
});

test('a model that searches natively never also gets the key tool', async () => {
  const responsesAnswer = sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'NATIVE' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
  const { bodies, out } = await keyConversation({ setup: home => writeKey(home), provider: 'openai', model: 'gpt-5.5', reply: () => [200, responsesAnswer] });
  assert.equal(bodies.length, 1, out);
  const tools = [...(bodies[0].tools ?? []), ...(bodies[0].input ?? []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools)];
  assert.ok(tools.some(t => t.type === 'web_search'), JSON.stringify(tools));
  assert.ok(!tools.some(t => t.type === 'function' && t.name === 'web_search'), JSON.stringify(tools));
});

test('--tools without web_search leaves the key tool out', async () => {
  const { bodies, out } = await keyConversation({ setup: home => writeKey(home), reply: () => [200, answers], tools: 'read' });
  assert.equal(bodies.length, 1, out);
  assert.ok(!declares(bodies[0], 'web_search'));
});

test('without a usable key, or with a service not yet enabled, no key tool is offered', async () => {
  for (const setup of [async () => {}, home => writeKey(home, undefined, 0o640),
    home => writeKey(home, { api_key: syntheticKey, backend: 'staan', source: 'own' })]) {
    const { bodies, out, braveRequests } = await keyConversation({ setup, reply: () => [200, answers] });
    assert.equal(bodies.length, 1, out);
    assert.ok(!declares(bodies[0], 'web_search'), JSON.stringify(bodies[0].tools));
    assert.equal(braveRequests.length, 0);
  }
});

// The model can change in a session; the key tool follows it, but a
// person's own decision to leave it out stands.
test('the key tool follows the model and respects a choice to leave it out', () => withHome(async home => {
  await writeKey(home);
  const handlers = {};
  let active = [];
  let registered = [];
  const pi = {
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerTool: tool => { registered.push(tool); active.push(tool.name); },
    getAllTools: () => registered.map(t => ({ name: t.name, parameters: t.parameters })),
    getActiveTools: () => [...active],
    setActiveTools: names => { active = [...names]; },
  };
  createExtension({ home: () => home })(pi);
  const emit = async (name, event, ctx) => { for (const h of handlers[name] ?? []) await h(event, ctx); };
  const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt' };
  const deepseek = { provider: 'deepseek', api: 'openai-completions', id: 'deepseek-flash' };
  await emit('session_start', {}, { model: codex });
  assert.deepEqual(active, []);
  await emit('model_select', { model: deepseek }, { model: codex });
  assert.deepEqual(active, ['web_search']);
  // The person's own search tool takes precedence, an MCP server's too.
  for (const own of ['WebFetch', 'mcp__personal__web_search']) {
    active = ['web_search', own];
    await emit('before_agent_start', {}, { model: deepseek });
    assert.deepEqual(active, [own]);
  }
  active = [];
  await emit('before_agent_start', {}, { model: deepseek });
  assert.deepEqual(active, ['web_search']);
  // Left out by the person: not put back.
  active = [];
  await emit('model_select', { model: deepseek }, {});
  await emit('before_agent_start', {}, { model: deepseek });
  assert.deepEqual(active, []);
}));

test('another extension\'s web_search is left alone', () => withHome(async home => {
  const handlers = {};
  const theirs = { name: 'web_search', parameters: { type: 'object' } };
  let active = ['web_search'];
  const pi = {
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerTool: () => {},
    // Pi keeps the first registration of a name: theirs.
    getAllTools: () => [theirs],
    getActiveTools: () => [...active],
    setActiveTools: names => { active = [...names]; },
  };
  createExtension({ home: () => home })(pi);
  const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt' };
  for (const h of handlers.session_start) await h({}, { model: codex });
  for (const h of handlers.before_agent_start) await h({}, { model: { provider: 'deepseek', api: 'openai-completions' } });
  assert.deepEqual(active, ['web_search'], 'no key and a native model, yet their tool stays');
}));

test('in Pi, a person\'s own web_search loaded first stays theirs and active', async () => {
  const own = resolve(here, 'fixtures/own-search.mjs');
  const service = await brave(() => [200, braveResults]);
  try {
    const { bodies, out } = await converse('deepseek', 'deepseek-flash', ['find it'], () => [200, answers], [own], {
      resource: fixture, tools: 'read,web_search', env: { PI_WEB_SEARCH_TEST_BRAVE: service.endpoint },
    });
    assert.equal(bodies.length, 1, out);
    const tool = (bodies[0].tools ?? []).find(t => t.function?.name === 'web_search');
    assert.match(tool?.function?.description ?? '', /OWN-SEARCH/, JSON.stringify(bodies[0].tools));
  } finally { service.close(); }
});
