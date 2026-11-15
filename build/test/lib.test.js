'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const lib = require('../lib');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST2 = `sha256:${'b'.repeat(64)}`;

function githubEnv(extra = {}) {
  return {
    'INPUT_POD': 'shop',
    'INPUT_API-URL': 'https://api.brainpod.test/',
    'INPUT_REGISTRY': 'registry.brainpod.test',
    'INPUT_CONFIG': 'steiger.yml',
    'INPUT_AUDIENCE': '',
    'INPUT_STEIGER-VERSION': 'v0.0.7',
    'INPUT_NORMALISE': 'true',
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_REPOSITORY_ID: '123',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW: 'Brainpod shop',
    GITHUB_REF: 'refs/heads/brainpod/onboarding-shop',
    GITHUB_SHA: 'c'.repeat(40),
    GITHUB_ACTOR: 'octocat',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.test/request?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    ACTIONS_RUNTIME_TOKEN: 'runtime-token',
    ACTIONS_CACHE_URL: 'https://cache.test/',
    ACTIONS_RESULTS_URL: 'https://results.test/',
    ...extra,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('getInputs reads action inputs and applies defaults', () => {
  const inputs = lib.getInputs(githubEnv({ 'INPUT_CONFIG': '', 'INPUT_STEIGER-VERSION': '', 'INPUT_NORMALISE': '' }));
  assert.deepEqual(inputs, {
    pod: 'shop',
    apiUrl: 'https://api.brainpod.test',
    registry: 'registry.brainpod.test',
    config: 'steiger.yml',
    audience: 'https://api.brainpod.test',
    steigerVersion: 'v0.0.7',
    normalise: true,
  });
  assert.equal(lib.getInputs(githubEnv({ 'INPUT_AUDIENCE': 'custom', 'INPUT_NORMALISE': 'false' })).audience, 'custom');
  assert.equal(lib.getInputs(githubEnv({ 'INPUT_NORMALISE': 'false' })).normalise, false);
  assert.throws(() => lib.getInputs(githubEnv({ 'INPUT_POD': '' })), /pod/);
  // Without api-url and registry, the build reports to Brainpod's own installation.
  const brainpod = lib.getInputs(githubEnv({ 'INPUT_API-URL': '', 'INPUT_REGISTRY': '' }));
  assert.equal(brainpod.apiUrl, 'https://api.brainpod.io');
  assert.equal(brainpod.registry, 'registry.brainpod.io');
  assert.equal(brainpod.audience, 'https://api.brainpod.io');
  assert.throws(() => lib.getInputs(githubEnv({ 'INPUT_NORMALISE': 'maybe' })), /normalise/);
});

test('buildTags and buildSource describe the workflow run', () => {
  const env = githubEnv();
  assert.deepEqual(lib.buildTags(env), {
    'git.rev': 'c'.repeat(40),
    'git.refname': 'refs/heads/brainpod/onboarding-shop',
    'github.repo': 'acme/shop',
    'github.workflow': 'Brainpod shop',
  });
  assert.deepEqual(lib.buildSource(env), {
    kind: 'github-actions',
    repository: 'acme/shop',
    repositoryId: 123,
    runId: 42,
    runAttempt: 2,
    runUrl: 'https://github.com/acme/shop/actions/runs/42',
    workflow: 'Brainpod shop',
    ref: 'refs/heads/brainpod/onboarding-shop',
    sha: 'c'.repeat(40),
    actor: 'octocat',
  });
  assert.equal(lib.buildSource(githubEnv({ GITHUB_REPOSITORY_ID: '' })), undefined);
  assert.equal(lib.buildSource(githubEnv({ GITHUB_SERVER_URL: 'http://ghes.test' })), undefined);
});

test('parseSteigerOutput reads steiger build output files', () => {
  const ref = `registry.brainpod.test/shop/web:abc123@${DIGEST}`;
  assert.deepEqual(lib.parseSteigerOutput(JSON.stringify({ builds: [{ imageName: 'web', tag: ref }] })), [
    { name: 'web', ref },
  ]);
  assert.deepEqual(lib.parseSteigerOutput('{"builds":[]}'), []);
  assert.throws(() => lib.parseSteigerOutput('nope'), /invalid output file/);
  assert.throws(() => lib.parseSteigerOutput('{}'), /no builds/);
  assert.throws(() => lib.parseSteigerOutput('{"builds":[{"imageName":"web"}]}'), /invalid build entry/);
});

test('parseImageRef requires a digest and keeps the tag', () => {
  assert.deepEqual(lib.parseImageRef(`registry.test:5000/shop/web:v1.2@${DIGEST}`), {
    repository: 'registry.test:5000/shop/web',
    tag: 'v1.2',
    digest: DIGEST,
  });
  assert.deepEqual(lib.parseImageRef(`registry.test/shop/web@${DIGEST}`), {
    repository: 'registry.test/shop/web',
    tag: undefined,
    digest: DIGEST,
  });
  assert.throws(() => lib.parseImageRef('registry.test/shop/web:latest'), /without a digest/);
});

test('eventConfig maps the Docker image config', () => {
  assert.deepEqual(
    lib.eventConfig(JSON.stringify({
      User: '1000:1000',
      WorkingDir: '/app',
      ExposedPorts: { '8080/tcp': {}, '9090/tcp': {} },
      Entrypoint: ['docker-entrypoint.sh'],
      Cmd: ['node', 'server.js'],
      Env: ['PATH=/usr/bin', 'NODE_ENV=production'],
      Labels: { a: 'b' },
    })),
    {
      user: '1000:1000',
      workingDir: '/app',
      exposedPorts: ['8080/tcp', '9090/tcp'],
      entrypoint: ['docker-entrypoint.sh'],
      cmd: ['node', 'server.js'],
      env: ['PATH=/usr/bin', 'NODE_ENV=production'],
    },
  );
  assert.deepEqual(lib.eventConfig({ User: '', Entrypoint: null, Cmd: [] }), {});
  assert.deepEqual(lib.eventConfig('null'), {});
});

test('root detection and normalisation candidates', () => {
  for (const user of [undefined, '', '0', 'root', '0:0', 'root:root']) assert.equal(lib.runsAsRoot(user), true, user);
  for (const user of ['1000', 'app', '1000:1000', 'node']) assert.equal(lib.runsAsRoot(user), false, user);
  assert.equal(lib.normaliseCandidate({ workingDir: '/app' }), true);
  assert.equal(lib.normaliseCandidate({ user: 'root', workingDir: '/app' }), true);
  assert.equal(lib.normaliseCandidate({ user: 'node', workingDir: '/app' }), false);
  assert.equal(lib.normaliseCandidate({ workingDir: '/' }), false);
  assert.equal(lib.normaliseCandidate({}), false);
});

test('normaliseDockerfile and repoDigest', () => {
  assert.equal(
    lib.normaliseDockerfile(`r/shop/web@${DIGEST}`, '/srv/my app'),
    `FROM r/shop/web@${DIGEST}\nUSER 0\nRUN ["chown","-R","1000:1000","/srv/my app"]\nUSER 1000:1000\n`,
  );
  const digests = JSON.stringify([`other.test/shop/web@${DIGEST}`, `registry.test/shop/web@${DIGEST2}`]);
  assert.equal(lib.repoDigest(digests, 'registry.test/shop/web'), DIGEST2);
  assert.throws(() => lib.repoDigest('[]', 'registry.test/shop/web'), /no pushed digest/);
  assert.throws(() => lib.repoDigest(digests, 'registry.test/shop/api'), /no pushed digest/);
});

test('event payloads', () => {
  assert.deepEqual(lib.elapsedSince(1000, 13_250), { secs: 12, nanos: 250_000_000 });
  assert.deepEqual(lib.completedEvent({ secs: 1, nanos: 0 }), { kind: 'completed', elapsed: { secs: 1, nanos: 0 } });
  assert.deepEqual(lib.startedEvent({ runUrl: 'https://x' }), { kind: 'started', runUrl: 'https://x' });
  assert.deepEqual(lib.startedEvent(undefined), { kind: 'started' });
  assert.deepEqual(lib.artifactEvent('u', {}), { kind: 'artifact', uri: 'u' });
  assert.deepEqual(lib.artifactEvent('u', { user: '1000' }), { kind: 'artifact', uri: 'u', config: { user: '1000' } });
  const failed = lib.failedEvent({ elapsed: { secs: 1, nanos: 0 }, reason: 'r'.repeat(3000), logTail: `${'x'.repeat(9000)}END` });
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.reason.length, 2000);
  assert.equal(failed.logTail.length, 8000);
  assert.ok(failed.logTail.endsWith('END'));
  assert.deepEqual(lib.failedEvent({ elapsed: { secs: 0, nanos: 0 } }), { kind: 'failed', elapsed: { secs: 0, nanos: 0 } });
});

test('steigerEnv keeps the Actions cache variables and drops steiger reporting', () => {
  const env = lib.steigerEnv({ ...githubEnv(), BUILD_EVENTS_TARGET: 't', BUILD_EVENTS_ENDPOINT: 'e', BUILD_EVENTS_TOKEN: 'k' });
  assert.equal(env.ACTIONS_RUNTIME_TOKEN, 'runtime-token');
  assert.equal(env.ACTIONS_CACHE_URL, 'https://cache.test/');
  assert.equal(env.ACTIONS_RESULTS_URL, 'https://results.test/');
  assert.equal('BUILD_EVENTS_TARGET' in env, false);
  assert.equal('BUILD_EVENTS_ENDPOINT' in env, false);
  assert.equal('BUILD_EVENTS_TOKEN' in env, false);
});

function recordingStream(options = {}) {
  const sent = [];
  const stream = new lib.LogStream({
    send: async (offset, text) => {
      sent.push({ offset, text });
      return options.respond ? options.respond(offset, text, sent.length) : { ok: true };
    },
    intervalMs: 60_000,
    ...options,
  });
  stream.start();
  return { stream, sent };
}

test('LogStream holds output until started and sends at byte offsets', async () => {
  const sent = [];
  const stream = new lib.LogStream({ send: async (offset, text) => (sent.push({ offset, text }), { ok: true }), intervalMs: 60_000 });
  stream.write('before ');
  await stream.flush();
  assert.deepEqual(sent, []);
  stream.start();
  stream.write('héllo\n');
  await stream.close();
  assert.deepEqual(sent, [{ offset: 0, text: 'before héllo\n' }]);
});

test('LogStream flushes at the threshold and splits events on character boundaries', async () => {
  const { stream, sent } = recordingStream({ maxEventBytes: 5, flushBytes: 8 });
  stream.write('abcd');
  await stream.flush();
  stream.write('€€€'); // 9 bytes, crosses the threshold
  await stream.close();
  assert.deepEqual(sent.map((s) => s.text).join(''), 'abcd€€€');
  for (const { text } of sent) assert.ok(Buffer.byteLength(text) <= 5);
  let offset = 0;
  for (const chunk of sent) {
    assert.equal(chunk.offset, offset);
    offset += Buffer.byteLength(chunk.text);
  }
});

test('LogStream never splits a character across writes', async () => {
  const { stream, sent } = recordingStream();
  const euro = Buffer.from('€');
  stream.write(Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]));
  await stream.flush();
  stream.write(euro.subarray(1));
  await stream.close();
  assert.deepEqual(sent, [
    { offset: 0, text: 'a' },
    { offset: 1, text: '€' },
  ]);
});

test('LogStream resynchronises on 409 using the stored length', async () => {
  const { stream, sent } = recordingStream({
    respond: (offset, text, n) => (n === 1 ? { ok: false, length: 3 } : { ok: true }),
  });
  stream.write('abcdef');
  await stream.close();
  assert.deepEqual(sent, [
    { offset: 0, text: 'abcdef' },
    { offset: 3, text: 'def' },
  ]);
});

test('LogStream keeps output after a failed send and gives up after repeated failures', async () => {
  let fail = true;
  const warnings = [];
  const sent = [];
  const stream = new lib.LogStream({
    maxFailures: 2,
    intervalMs: 60_000,
    warn: (m) => warnings.push(m),
    send: async (offset, text) => {
      sent.push({ offset, text });
      if (fail) throw new Error('boom');
      return { ok: true };
    },
  });
  stream.start();
  stream.write('a');
  await stream.flush();
  fail = false;
  stream.write('b');
  await stream.flush();
  assert.deepEqual(sent.at(-1), { offset: 0, text: 'ab' });

  fail = true;
  stream.write('c');
  await stream.flush();
  await stream.flush();
  assert.equal(warnings.length, 1);
  stream.write('d');
  await stream.close();
  assert.equal(sent.at(-1).text, 'c');
  assert.equal(stream.tail(), 'abcd');
});

test('LogStream keeps the last characters as the tail', async () => {
  const { stream } = recordingStream({ tailChars: 4 });
  stream.write('abcdefgh');
  await stream.close();
  assert.equal(stream.tail(), 'efgh');
});

test('requestOidcToken asks for the audience and exchangeToken calls Brainpod', async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://token.test')) return jsonResponse(200, { value: 'jwt' });
    return jsonResponse(200, { token: 'secret', podId: 'pod-id', pod: 'shop', expiresAt: 'x' });
  };
  const idToken = await lib.requestOidcToken({ env: githubEnv(), audience: 'https://api.brainpod.test', fetch });
  assert.equal(idToken, 'jwt');
  assert.equal(calls[0].url, 'https://token.test/request?api-version=2.0&audience=https%3A%2F%2Fapi.brainpod.test');
  assert.equal(calls[0].init.headers.authorization, 'bearer request-token');

  const exchange = await lib.exchangeToken({ apiUrl: 'https://api.brainpod.test', pod: 'shop', idToken, fetch });
  assert.equal(exchange.token, 'secret');
  assert.equal(calls[1].url, 'https://api.brainpod.test/oidc/github/token');
  assert.equal(calls[1].init.headers.authorization, 'Bearer jwt');
  assert.deepEqual(JSON.parse(calls[1].init.body), { pod: 'shop' });

  await assert.rejects(
    lib.requestOidcToken({ env: {}, audience: 'a', fetch }),
    /id-token: write/,
  );
  await assert.rejects(
    lib.exchangeToken({
      apiUrl: 'https://api',
      pod: 'shop',
      idToken: 'jwt',
      fetch: async () => jsonResponse(403, { error: { code: 'forbidden', message: 'ref not allowed' } }),
    }),
    /HTTP 403: ref not allowed/,
  );
});

test('BuildsApi uses Basic auth and returns the stored length on 409', async () => {
  const calls = [];
  const api = new lib.BuildsApi({
    apiUrl: 'https://api',
    pod: 'shop',
    token: 'secret',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? jsonResponse(409, { error: 'gap', length: 7 }) : jsonResponse(500, { error: 'down' });
    },
  });
  assert.deepEqual(await api.log('b1', 10, 'x'), { ok: false, length: 7 });
  assert.equal(calls[0].url, 'https://api/builds/b1/events');
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('shop:secret').toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { event: { kind: 'log', offset: 10, text: 'x' } });
  await assert.rejects(api.log('b1', 0, 'x'), /HTTP 500: down/);
});

function fakeBrainpod() {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body, headers: init.headers });
    if (url.startsWith('https://token.test')) return jsonResponse(200, { value: 'jwt' });
    if (url.endsWith('/oidc/github/token')) {
      return jsonResponse(200, { token: 'machine-secret', podId: 'pod-uuid', pod: 'shop', expiresAt: 'x' });
    }
    if (url.endsWith('/builds')) return jsonResponse(201, { id: 'build-1' });
    if (url.endsWith('/builds/build-1/events')) return jsonResponse(201, {});
    if (url.includes('/releases/download/')) return new Response('#!/bin/sh\n', { status: 200 });
    return jsonResponse(404, { error: 'unknown' });
  };
  const events = () => requests.filter((r) => r.url.endsWith('/events')).map((r) => r.body.event);
  return { fetch, requests, events };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'build-action-test-'));
}

function fakeDocker({ steigerCode = 0, user = '', owner = '0' } = {}) {
  const calls = [];
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const ok = (stdout = '') => {
      if (options.onOutput && stdout) options.onOutput(Buffer.from(stdout));
      return { code: 0, stdout, stderr: '' };
    };
    if (cmd === 'docker' && args[0] === 'login') return ok('Login Succeeded\n');
    if (path.basename(cmd) === 'steiger') {
      options.onOutput(Buffer.from('building web\n'));
      if (steigerCode !== 0) return { code: steigerCode, stdout: '', stderr: 'boom' };
      const file = args[args.indexOf('--output-file') + 1];
      fs.writeFileSync(file, JSON.stringify({ builds: [{ imageName: 'web', tag: `registry.brainpod.test/shop/web:abc@${DIGEST}` }] }));
      return ok();
    }
    if (args[0] === 'pull') return ok(`${args.at(-1)}\n`);
    if (args[0] === 'image' && args[3] === '{{json .Config}}') {
      const normalised = args[4].endsWith(DIGEST2);
      return ok(JSON.stringify({
        User: normalised ? '1000:1000' : user,
        WorkingDir: '/app',
        ExposedPorts: { '3000/tcp': {} },
        Cmd: ['node', 'server.js'],
      }));
    }
    if (args[0] === 'image' && args[3] === '{{json .RepoDigests}}') {
      return ok(JSON.stringify([`registry.brainpod.test/shop/web@${DIGEST2}`]));
    }
    if (args[0] === 'build' || args[0] === 'push') return ok();
    if (args[0] === 'run') return ok(`${owner}\n`);
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  };
  return { exec, calls };
}

function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(String(c)), text: () => chunks.join('') };
}

test('run builds, normalises a root image and reports the Build', async () => {
  const brainpod = fakeBrainpod();
  const docker = fakeDocker({ user: '', owner: '0' });
  const toolCache = tempDir();
  const stdout = sink();
  let clock = 1_000;
  const result = await lib.run({
    env: githubEnv({ RUNNER_TOOL_CACHE: toolCache, GITHUB_WORKSPACE: '/work' }),
    fetch: brainpod.fetch,
    exec: docker.exec,
    stdout,
    now: () => (clock += 1_000),
    tmpdir: tempDir(),
  });

  const ref = `registry.brainpod.test/shop/web@${DIGEST2}`;
  assert.deepEqual(result, { buildId: 'build-1', artifacts: { web: ref } });
  assert.ok(stdout.text().includes('::add-mask::jwt\n'));
  assert.ok(stdout.text().includes('::add-mask::machine-secret\n'));
  assert.ok(stdout.text().includes('building web\n'));

  const login = docker.calls[0];
  assert.deepEqual(login.args, ['login', 'registry.brainpod.test', '-u', 'shop', '--password-stdin']);
  assert.equal(login.options.input, 'machine-secret');

  const create = brainpod.requests.find((r) => r.url.endsWith('/builds'));
  assert.equal(create.body.target, 'urn:brainpod:pod:pod-uuid');
  assert.equal(create.body.tags['git.rev'], 'c'.repeat(40));
  assert.equal(create.body.source.runId, 42);
  assert.equal(create.headers.authorization, `Basic ${Buffer.from('shop:machine-secret').toString('base64')}`);

  const steiger = docker.calls.find((c) => path.basename(c.cmd) === 'steiger');
  assert.equal(steiger.cmd, path.join(toolCache, 'steiger', '0.0.7', 'x64', 'steiger'));
  assert.deepEqual(steiger.args.slice(0, 5), ['--config', 'steiger.yml', 'build', '--repo', 'registry.brainpod.test/shop']);
  assert.equal(steiger.options.cwd, '/work');
  assert.equal(steiger.options.env.ACTIONS_RUNTIME_TOKEN, 'runtime-token');
  assert.equal('BUILD_EVENTS_TARGET' in steiger.options.env, false);

  const stat = docker.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(stat.args, [
    'run', '--rm', '--user', '0', '--entrypoint', 'sh', `registry.brainpod.test/shop/web@${DIGEST}`,
    '-c', 'stat -c %u "$1"', 'sh', '/app',
  ]);
  assert.deepEqual(docker.calls.find((c) => c.args[0] === 'pull').args, ['pull', '--quiet', `registry.brainpod.test/shop/web@${DIGEST}`]);
  const build = docker.calls.find((c) => c.args[0] === 'build');
  assert.equal(build.args[build.args.indexOf('--tag') + 1], 'registry.brainpod.test/shop/web:abc-brainpod');
  assert.deepEqual(docker.calls.find((c) => c.args[0] === 'push').args, ['push', 'registry.brainpod.test/shop/web:abc-brainpod']);
  const dockerfile = fs.readFileSync(path.join(build.args.at(-1), 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.startsWith(`FROM registry.brainpod.test/shop/web@${DIGEST}\n`));

  const events = brainpod.events();
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'started');
  assert.equal(events[0].runUrl, 'https://github.com/acme/shop/actions/runs/42');
  assert.deepEqual(events.find((e) => e.kind === 'artifact'), {
    kind: 'artifact',
    uri: ref,
    config: { user: '1000:1000', workingDir: '/app', exposedPorts: ['3000/tcp'], cmd: ['node', 'server.js'] },
  });
  assert.equal(kinds.at(-1), 'completed');
  assert.ok(kinds.indexOf('artifact') < kinds.indexOf('completed'));
  const log = events.filter((e) => e.kind === 'log').map((e) => e.text).join('');
  assert.ok(log.includes('building web\n'));
  assert.ok(log.includes('Login Succeeded'));
  assert.ok(!log.includes('machine-secret'));
});

test('run leaves non-root images and owned working directories alone', async () => {
  for (const options of [{ user: 'node' }, { user: '', owner: '1000' }]) {
    const brainpod = fakeBrainpod();
    const docker = fakeDocker(options);
    const result = await lib.run({
      env: githubEnv({ RUNNER_TOOL_CACHE: tempDir() }),
      fetch: brainpod.fetch,
      exec: docker.exec,
      stdout: sink(),
      tmpdir: tempDir(),
    });
    assert.equal(result.artifacts.web, `registry.brainpod.test/shop/web@${DIGEST}`);
    assert.equal(docker.calls.some((c) => c.args[0] === 'build' || c.args[0] === 'push'), false);
  }
});

test('run reports a failed steiger build with the log tail and rethrows', async () => {
  const brainpod = fakeBrainpod();
  const docker = fakeDocker({ steigerCode: 3 });
  await assert.rejects(
    lib.run({
      env: githubEnv({ RUNNER_TOOL_CACHE: tempDir() }),
      fetch: brainpod.fetch,
      exec: docker.exec,
      stdout: sink(),
      tmpdir: tempDir(),
    }),
    /steiger build failed: steiger exited with code 3/,
  );
  const events = brainpod.events();
  const failed = events.at(-1);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.reason, /steiger exited with code 3/);
  assert.ok(failed.logTail.includes('building web\n'));
  assert.equal(events.some((e) => e.kind === 'completed'), false);
});

test('ensureSteiger downloads once into the tool cache', async () => {
  const brainpod = fakeBrainpod();
  const env = { RUNNER_TOOL_CACHE: tempDir() };
  const log = () => {};
  const binary = await lib.ensureSteiger({ version: 'v0.0.7', env, fetch: brainpod.fetch, log });
  assert.equal(
    brainpod.requests[0].url,
    'https://github.com/brainhivenl/steiger/releases/download/v0.0.7/steiger-x86_64-unknown-linux-gnu',
  );
  assert.equal(fs.statSync(binary).mode & 0o111, 0o111);
  await lib.ensureSteiger({ version: 'v0.0.7', env, fetch: brainpod.fetch, log });
  assert.equal(brainpod.requests.length, 1);
});

test('exec runs a process with stdin and captures output', async () => {
  const chunks = [];
  const result = await lib.exec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input: 'hello',
    onOutput: (c) => chunks.push(String(c)),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(chunks.join(''), 'hello');
});
