'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const STEIGER_ASSET = 'steiger-x86_64-unknown-linux-gnu';
const MAX_LOG_EVENT_BYTES = 64 * 1024;
const LOG_FLUSH_BYTES = 32 * 1024;
const LOG_FLUSH_INTERVAL_MS = 2000;
const MAX_REASON_CHARS = 2000;
const MAX_LOG_TAIL_CHARS = 8000;
const NORMALISED_UID = '1000';

// ---------------------------------------------------------------------------
// Inputs and GitHub context

function getInput(env, name) {
  const value = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return value === undefined ? '' : value.trim();
}

function parseBoolean(value, name) {
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  throw new Error(`Input ${name} must be true or false, got "${value}"`);
}

function getInputs(env) {
  const required = (name) => {
    const value = getInput(env, name);
    if (!value) throw new Error(`Input required and not supplied: ${name}`);
    return value;
  };
  const apiUrl = required('api-url').replace(/\/+$/, '');
  return {
    pod: required('pod'),
    apiUrl,
    registry: required('registry').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''),
    config: getInput(env, 'config') || 'steiger.yml',
    audience: getInput(env, 'audience') || apiUrl,
    steigerVersion: getInput(env, 'steiger-version') || 'v0.0.7',
    normalise: parseBoolean(getInput(env, 'normalise') || 'true', 'normalise'),
  };
}

function buildTags(env) {
  const tags = { 'git.rev': env.GITHUB_SHA || '', 'git.refname': env.GITHUB_REF || '' };
  if (env.GITHUB_REPOSITORY) tags['github.repo'] = env.GITHUB_REPOSITORY;
  if (env.GITHUB_WORKFLOW) tags['github.workflow'] = env.GITHUB_WORKFLOW;
  return tags;
}

function toInt(value) {
  return /^\d+$/.test(value || '') ? Number(value) : undefined;
}

// The Build's `source`; every field is required by the API, so it is omitted
// when the GitHub context is incomplete.
function buildSource(env) {
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const source = {
    kind: 'github-actions',
    repository: env.GITHUB_REPOSITORY,
    repositoryId: toInt(env.GITHUB_REPOSITORY_ID),
    runId: toInt(env.GITHUB_RUN_ID),
    runAttempt: toInt(env.GITHUB_RUN_ATTEMPT),
    runUrl: `${serverUrl}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    workflow: env.GITHUB_WORKFLOW,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    actor: env.GITHUB_ACTOR,
  };
  const complete = Object.values(source).every((value) => value !== undefined && value !== '');
  if (!complete || !source.runUrl.startsWith('https://')) return undefined;
  return source;
}

// ---------------------------------------------------------------------------
// HTTP

async function responseError(response, what) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      const error = body && body.error;
      detail = typeof error === 'string' ? error : (error && error.message) || text;
    } catch {
      detail = text;
    }
  } catch {
    // The body is not needed to report the status.
  }
  const message = `${what} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function requestOidcToken({ env, audience, fetch }) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Error('GitHub OIDC is unavailable: the job needs `permissions: id-token: write`');
  }
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) throw await responseError(response, 'Requesting the GitHub OIDC token');
  const body = await response.json();
  if (!body || typeof body.value !== 'string' || !body.value) {
    throw new Error('GitHub returned no OIDC token');
  }
  return body.value;
}

async function exchangeToken({ apiUrl, pod, idToken, fetch }) {
  const response = await fetch(`${apiUrl}/oidc/github/token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ pod }),
  });
  if (!response.ok) throw await responseError(response, 'Exchanging the GitHub OIDC token with Brainpod');
  const body = await response.json();
  if (!body || typeof body.token !== 'string' || typeof body.podId !== 'string') {
    throw new Error('Brainpod returned an invalid token response');
  }
  return body;
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

class BuildsApi {
  constructor({ apiUrl, pod, token, fetch }) {
    this.apiUrl = apiUrl;
    this.fetch = fetch;
    this.authorization = basicAuth(pod, token);
  }

  async post(urlPath, body) {
    return this.fetch(`${this.apiUrl}${urlPath}`, {
      method: 'POST',
      headers: {
        authorization: this.authorization,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async createBuild(body) {
    const response = await this.post('/builds', body);
    if (!response.ok) throw await responseError(response, 'Creating the Brainpod build');
    const { id } = await response.json();
    if (typeof id !== 'string' || !id) throw new Error('Brainpod returned no build id');
    return id;
  }

  // Sends one event; throws on any non-2xx response.
  async event(buildId, event) {
    const response = await this.post(`/builds/${encodeURIComponent(buildId)}/events`, { event });
    if (!response.ok) throw await responseError(response, `Sending the ${event.kind} event`);
  }

  // Sends a log event. Returns `{ ok: true }` or, on 409, the stored log
  // length as `{ ok: false, length }`.
  async log(buildId, offset, text) {
    const response = await this.post(`/builds/${encodeURIComponent(buildId)}/events`, {
      event: { kind: 'log', offset, text },
    });
    if (response.ok) return { ok: true };
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body && Number.isInteger(body.length)) return { ok: false, length: body.length };
    }
    throw await responseError(response, 'Sending the log event');
  }
}

// ---------------------------------------------------------------------------
// Events

function elapsedSince(startMs, nowMs) {
  const ms = Math.max(0, nowMs - startMs);
  return { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

function completedEvent(elapsed) {
  return { kind: 'completed', elapsed };
}

function failedEvent({ elapsed, reason, logTail }) {
  const event = { kind: 'failed', elapsed };
  if (reason) event.reason = String(reason).slice(0, MAX_REASON_CHARS);
  if (logTail) event.logTail = logTail.slice(-MAX_LOG_TAIL_CHARS);
  return event;
}

function startedEvent(source) {
  const event = { kind: 'started' };
  if (source) event.runUrl = source.runUrl;
  return event;
}

function artifactEvent(uri, config) {
  const event = { kind: 'artifact', uri };
  if (config && Object.keys(config).length > 0) event.config = config;
  return event;
}

// ---------------------------------------------------------------------------
// Log streaming

// Largest prefix length of `buffer`, at most `max` bytes, that ends on a UTF-8
// character boundary and does not end in an incomplete character.
function utf8Boundary(buffer, max) {
  let cut = Math.min(max, buffer.length);
  if (cut < buffer.length) {
    while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut--;
    return cut;
  }
  // The whole buffer fits; drop a trailing incomplete character.
  for (let back = 1; back <= Math.min(4, cut); back++) {
    const byte = buffer[cut - back];
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? cut - back : cut;
  }
  return cut;
}

// Buffers log output and sends it as `log` events at increasing byte offsets.
// Sends are serialised; a 409 resynchronises to the length Brainpod stored.
class LogStream {
  constructor({
    send,
    warn = () => {},
    maxEventBytes = MAX_LOG_EVENT_BYTES,
    flushBytes = LOG_FLUSH_BYTES,
    intervalMs = LOG_FLUSH_INTERVAL_MS,
    tailChars = MAX_LOG_TAIL_CHARS,
    maxFailures = 5,
  }) {
    this.send = send;
    this.warn = warn;
    this.maxEventBytes = maxEventBytes;
    this.flushBytes = flushBytes;
    this.intervalMs = intervalMs;
    this.tailChars = tailChars;
    this.maxFailures = maxFailures;
    this.pending = Buffer.alloc(0);
    this.offset = 0; // byte offset of `pending[0]` in the Build's log
    this.failures = 0;
    this.disabled = !send;
    this.decoder = new StringDecoder('utf8');
    this.tailText = '';
    this.chain = Promise.resolve();
    this.timer = undefined;
    this.started = false;
  }

  // Starts sending: buffered output is held until the Build exists.
  start() {
    if (this.started) return;
    this.started = true;
    if (this.disabled) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref();
  }

  write(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (bytes.length === 0) return;
    this.tailText = (this.tailText + this.decoder.write(bytes)).slice(-this.tailChars);
    if (this.disabled) return;
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.pending.length >= this.flushBytes) this.flush();
  }

  tail() {
    return this.tailText;
  }

  // Sends everything currently buffered. Resolves once it is sent (or given up).
  flush() {
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    const rest = this.decoder.end();
    if (rest) this.tailText = (this.tailText + rest).slice(-this.tailChars);
    await this.flush();
    if (!this.disabled && this.pending.length > 0) {
      // A trailing incomplete character can never be completed now.
      this.pending = Buffer.from(this.pending.toString('utf8'));
      await this.flush();
    }
  }

  async drain() {
    while (this.started && !this.disabled && this.pending.length > 0) {
      const size = utf8Boundary(this.pending, this.maxEventBytes);
      if (size === 0) return;
      const text = this.pending.subarray(0, size).toString('utf8');
      let result;
      try {
        result = await this.send(this.offset, text);
      } catch (error) {
        this.failures++;
        if (this.failures >= this.maxFailures) {
          this.disabled = true;
          this.warn(`Stopped sending the build log to Brainpod: ${error.message}`);
        }
        return;
      }
      this.failures = 0;
      if (result && result.ok === false) {
        this.resync(result.length);
        continue;
      }
      this.pending = this.pending.subarray(size);
      this.offset += size;
    }
  }

  // Brainpod stores `length` bytes. Skip what it already has; if it has less
  // than this stream already dropped, continue at its length.
  resync(length) {
    if (length > this.offset) {
      const skip = Math.min(length - this.offset, this.pending.length);
      let cut = skip;
      while (cut < this.pending.length && (this.pending[cut] & 0xc0) === 0x80) cut++;
      this.pending = this.pending.subarray(cut);
      this.offset = length + (cut - skip);
    } else {
      this.offset = length;
    }
  }
}

// ---------------------------------------------------------------------------
// steiger output and images

// steiger writes `{"builds":[{"imageName":"web","tag":"<repo>/web:<tag>@sha256:…"}]}`.
function parseSteigerOutput(text) {
  let output;
  try {
    output = JSON.parse(text);
  } catch (error) {
    throw new Error(`steiger wrote an invalid output file: ${error.message}`);
  }
  if (!output || !Array.isArray(output.builds)) {
    throw new Error('steiger output file has no builds');
  }
  return output.builds.map((build) => {
    if (!build || typeof build.imageName !== 'string' || typeof build.tag !== 'string') {
      throw new Error('steiger output file has an invalid build entry');
    }
    return { name: build.imageName, ref: build.tag };
  });
}

function parseImageRef(ref) {
  const match = /^(.+?)(?::([\w][\w.-]{0,127}))?@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (!match) throw new Error(`steiger reported an image without a digest: ${ref}`);
  return { repository: match[1], tag: match[2], digest: match[3] };
}

function artifactRepository({ registry, pod, name }) {
  return `${registry}/${pod}/${name}`;
}

function stringList(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length > 0
    ? value
    : undefined;
}

// Maps a Docker image config (`docker image inspect --format '{{json .Config}}'`)
// to the artifact event's `config`.
function eventConfig(dockerConfig) {
  const config = (typeof dockerConfig === 'string' ? JSON.parse(dockerConfig) : dockerConfig) || {};
  const result = {};
  if (typeof config.User === 'string' && config.User) result.user = config.User;
  if (typeof config.WorkingDir === 'string' && config.WorkingDir) result.workingDir = config.WorkingDir;
  if (config.ExposedPorts && typeof config.ExposedPorts === 'object') {
    const ports = Object.keys(config.ExposedPorts);
    if (ports.length > 0) result.exposedPorts = ports;
  }
  for (const [from, to] of [['Entrypoint', 'entrypoint'], ['Cmd', 'cmd'], ['Env', 'env']]) {
    const list = stringList(config[from]);
    if (list) result[to] = list;
  }
  return result;
}

function runsAsRoot(user) {
  const name = (user || '').split(':')[0].trim();
  return name === '' || name === '0' || name === 'root';
}

// Whether the image needs normalising before checking the working directory owner.
function normaliseCandidate(config) {
  const workingDir = config.workingDir || '';
  return runsAsRoot(config.user) && workingDir !== '' && workingDir !== '/';
}

function normaliseDockerfile(ref, workingDir) {
  return [
    `FROM ${ref}`,
    'USER 0',
    `RUN ${JSON.stringify(['chown', '-R', '1000:1000', workingDir])}`,
    'USER 1000:1000',
    '',
  ].join('\n');
}

// The digest of `repository` from `docker image inspect --format '{{json .RepoDigests}}'`.
function repoDigest(json, repository) {
  const digests = typeof json === 'string' ? JSON.parse(json) : json;
  const prefix = `${repository}@`;
  const match = (Array.isArray(digests) ? digests : []).find(
    (entry) => typeof entry === 'string' && entry.startsWith(prefix),
  );
  const digest = match && match.slice(prefix.length);
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`docker reported no pushed digest for ${repository}`);
  }
  return digest;
}

// Environment for steiger: the runner's environment, which carries
// ACTIONS_RUNTIME_TOKEN, ACTIONS_CACHE_URL and ACTIONS_RESULTS_URL for the
// buildx `type=gha` cache, without steiger's own Build events reporting.
function steigerEnv(env) {
  const result = { ...env };
  delete result.BUILD_EVENTS_TARGET;
  delete result.BUILD_EVENTS_ENDPOINT;
  delete result.BUILD_EVENTS_TOKEN;
  return result;
}

// ---------------------------------------------------------------------------
// Processes and files

// Runs a command. Output goes to `onOutput` (when given) and is also returned.
function exec(command, args, { input, env, cwd, onOutput, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (onOutput) onOutput(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (onOutput) onOutput(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, sig) => {
      resolve({
        code: code === null ? 128 : code,
        signal: sig,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

async function ensureSteiger({ version, env, fetch, log }) {
  const cacheRoot = env.RUNNER_TOOL_CACHE || path.join(os.tmpdir(), 'tool-cache');
  const dir = path.join(cacheRoot, 'steiger', version.replace(/^v/, ''), 'x64');
  const binary = path.join(dir, 'steiger');
  if (fs.existsSync(`${dir}.complete`) && fs.existsSync(binary)) {
    log(`Using cached steiger ${version}\n`);
    return binary;
  }
  const url = `https://github.com/brainhivenl/steiger/releases/download/${version}/${STEIGER_ASSET}`;
  log(`Downloading steiger ${version} from ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw await responseError(response, `Downloading steiger ${version}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${binary}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o755 });
  fs.renameSync(temp, binary);
  fs.writeFileSync(`${dir}.complete`, '');
  return binary;
}

// ---------------------------------------------------------------------------
// The build

class StepError extends Error {}

async function run({ env, fetch, exec: execFn = exec, stdout, now = Date.now, tmpdir, signal }) {
  const out = (text) => stdout.write(text);
  const command = (text) => out(`::${text}\n`);
  const inputs = getInputs(env);
  const startedAt = now();

  const idToken = await requestOidcToken({ env, audience: inputs.audience, fetch });
  command(`add-mask::${idToken}`);
  const exchange = await exchangeToken({ apiUrl: inputs.apiUrl, pod: inputs.pod, idToken, fetch });
  command(`add-mask::${exchange.token}`);

  const api = new BuildsApi({ apiUrl: inputs.apiUrl, pod: inputs.pod, token: exchange.token, fetch });
  const source = buildSource(env);
  let buildId;
  const logStream = new LogStream({
    send: (offset, text) => api.log(buildId, offset, text),
    warn: (message) => command(`warning::${message}`),
  });
  const log = (text) => {
    out(text);
    logStream.write(text);
  };
  const execLogged = async (cmd, args, options = {}) => {
    log(`$ ${[cmd, ...args].join(' ')}\n`);
    const result = await execFn(cmd, args, { env, ...options, onOutput: options.quiet ? undefined : log, signal });
    if (result.code !== 0) {
      if (options.quiet) log(result.stdout + result.stderr);
      throw new StepError(`${path.basename(cmd)} exited with code ${result.code}`);
    }
    return result;
  };

  await execLogged('docker', ['login', inputs.registry, '-u', inputs.pod, '--password-stdin'], {
    input: exchange.token,
  });

  const createBody = { target: `urn:brainpod:pod:${exchange.podId}`, tags: buildTags(env) };
  if (source) createBody.source = source;
  buildId = await api.createBuild(createBody);
  out(`Brainpod build ${buildId}\n`);
  logStream.start();

  const artifacts = {};
  try {
    await api.event(buildId, startedEvent(source));

    const steiger = await ensureSteiger({ version: inputs.steigerVersion, env, fetch, log });
    const work = fs.mkdtempSync(path.join(tmpdir || env.RUNNER_TEMP || os.tmpdir(), 'brainpod-build-'));
    const outputFile = path.join(work, 'out.json');
    const repo = `${inputs.registry}/${inputs.pod}`;
    await execLogged(
      steiger,
      ['--config', inputs.config, 'build', '--repo', repo, '--output-file', outputFile],
      { env: steigerEnv(env), cwd: env.GITHUB_WORKSPACE || undefined },
    ).catch((error) => {
      throw error instanceof StepError ? new StepError(`steiger build failed: ${error.message}`) : error;
    });

    const builds = parseSteigerOutput(fs.readFileSync(outputFile, 'utf8'));
    for (const build of builds) {
      const repository = artifactRepository({ registry: inputs.registry, pod: inputs.pod, name: build.name });
      const { digest, tag } = parseImageRef(build.ref);
      let ref = `${repository}@${digest}`;
      let config = await inspectConfig(execLogged, ref);

      if (inputs.normalise && normaliseCandidate(config)) {
        const owner = await workingDirOwner(execLogged, ref, config.workingDir, log);
        if (owner !== undefined && owner !== NORMALISED_UID) {
          log(`Normalising ${build.name}: it runs as root and ${config.workingDir} is owned by ${owner}\n`);
          const normalisedDigest = await normalise(execLogged, {
            ref,
            repository,
            workingDir: config.workingDir,
            target: `${repository}:${tag || env.GITHUB_SHA || 'latest'}-brainpod`,
            dir: fs.mkdtempSync(path.join(work, `${build.name}-`)),
          });
          ref = `${repository}@${normalisedDigest}`;
          config = await inspectConfig(execLogged, ref, { pull: false });
        }
      }

      await api.event(buildId, artifactEvent(ref, config));
      artifacts[build.name] = ref;
      log(`Artifact ${build.name}: ${ref}\n`);
    }

    await logStream.close();
    await api.event(buildId, completedEvent(elapsedSince(startedAt, now())));
  } catch (error) {
    const reason = signal && signal.aborted ? 'The workflow run was cancelled' : error.message;
    log(`Error: ${reason}\n`);
    await logStream.close();
    try {
      await api.event(buildId, failedEvent({ elapsed: elapsedSince(startedAt, now()), reason, logTail: logStream.tail() }));
    } catch (reportError) {
      command(`warning::Reporting the failure to Brainpod failed: ${reportError.message}`);
    }
    throw error;
  }
  return { buildId, artifacts };
}

// Reads the image config through the Docker daemon, which honours its
// registry settings (such as insecure registries).
async function inspectConfig(execLogged, ref, { pull = true } = {}) {
  if (pull) await execLogged('docker', ['pull', '--quiet', ref]);
  const { stdout } = await execLogged('docker', ['image', 'inspect', '--format', '{{json .Config}}', ref], {
    quiet: true,
  });
  return eventConfig(stdout);
}

// The uid owning `workingDir`, or undefined when the image cannot tell (no sh or stat).
async function workingDirOwner(execLogged, ref, workingDir, log) {
  try {
    const { stdout } = await execLogged(
      'docker',
      ['run', '--rm', '--user', '0', '--entrypoint', 'sh', ref, '-c', 'stat -c %u "$1"', 'sh', workingDir],
      { quiet: true },
    );
    const owner = stdout.trim().split('\n').pop().trim();
    if (/^\d+$/.test(owner)) return owner;
  } catch {
    // Reported below.
  }
  log(`Could not read the owner of ${workingDir} in ${ref}; not normalising it\n`);
  return undefined;
}

// Rebuilds `ref` with the default Docker builder so it runs as 1000:1000 and
// owns its working directory, pushes it and returns the pushed digest.
async function normalise(execLogged, { ref, repository, workingDir, target, dir }) {
  fs.writeFileSync(path.join(dir, 'Dockerfile'), normaliseDockerfile(ref, workingDir));
  await execLogged('docker', ['build', '--tag', target, dir]);
  await execLogged('docker', ['push', target]);
  const { stdout } = await execLogged('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', target], {
    quiet: true,
  });
  return repoDigest(stdout, repository);
}

module.exports = {
  BuildsApi,
  LogStream,
  artifactEvent,
  basicAuth,
  buildSource,
  buildTags,
  completedEvent,
  elapsedSince,
  ensureSteiger,
  eventConfig,
  exchangeToken,
  exec,
  failedEvent,
  getInputs,
  normaliseCandidate,
  normaliseDockerfile,
  parseImageRef,
  parseSteigerOutput,
  repoDigest,
  requestOidcToken,
  run,
  runsAsRoot,
  startedEvent,
  steigerEnv,
};
