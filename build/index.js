'use strict';

const fs = require('node:fs');
const { run } = require('./lib');

function escapeCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `brainpod_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main() {
  // A cancelled job gets SIGINT, then SIGTERM: stop steiger and report the Build as failed.
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());

  try {
    const { buildId, artifacts } = await run({
      env: process.env,
      fetch: globalThis.fetch,
      stdout: process.stdout,
      signal: controller.signal,
    });
    setOutput('build-id', buildId);
    setOutput('artifacts', JSON.stringify(artifacts));
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`::error::${escapeCommand(error.message)}\n`);
  }
}

main();
