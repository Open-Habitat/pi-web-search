import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = resolve(here, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const extension = resolve(here, '../extension.mjs');

export const sse = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// The real pinned Pi, the shipped extension and a synthetic provider endpoint:
// what Pi actually sends, and whether it survives what comes back.
// `options`: `resource` replaces the shipped extension (a test fixture
// wrapping it), `tools` is Pi's tool allowlist (`null`: none, Pi's defaults), `env` adds to Pi's
// environment, and `setup(home)` and `inspect(home)` run before Pi starts
// and after it ends.
export async function converse(provider, model, prompts, reply, extra = [], options = {}) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(data));
      const [status, body] = reply(bodies.length);
      res.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' });
      res.end(body);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const home = await mkdtemp(join(tmpdir(), 'pi-web-search-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}${provider === 'openai' ? '/v1' : ''}`;
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { [provider]: { baseUrl: base } } }), { mode: 0o600 });
    await options.setup?.(home);
    // An opt-in run checks the published git package's installation and native
    // manifest discovery, rather than passing its extension path explicitly.
    const packageSource = process.env.PI_WEB_SEARCH_TEST_PACKAGE;
    if (packageSource) {
      const installed = spawnSync(process.execPath, [cli, 'install', packageSource], {
        cwd: home, encoding: 'utf8', timeout: 60000,
        env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: home },
      });
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    }
    const resource = packageSource ? [] : ['--extension', options.resource ?? extension];
    const child = spawn(process.execPath, [cli, ...extra.flatMap(e => ['--extension', e]), ...resource, '--provider', provider, '--model', model,
      '--no-session', ...(options.tools === null ? [] : ['--tools', options.tools ?? 'read']), '--thinking', 'low', '-p', ...prompts], {
      cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', OPENAI_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic', DEEPSEEK_API_KEY: 'synthetic', ...options.env },
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    await new Promise(r => child.on('close', r));
    clearTimeout(timer);
    await options.inspect?.(home);
    return { bodies, out };
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
}

