import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(tmpdir(), 'payment-smoke-'));
const dataFile = join(directory, 'payments.json');
let child;
let base;

async function start(delayMs) {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_FILE: dataFile,
      SIMULATION_DELAY_MS: String(delayMs),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Server exited during startup: ${output}`);
    if (output.includes('"event":"runtime.ready"')) return;
    await delay(25);
  }
  throw new Error(`Server did not start: ${output}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const exited = once(current, 'exit');
  current.kill('SIGTERM');
  const timer = setTimeout(() => current.kill('SIGKILL'), 6000);
  try {
    const [code, signal] = await exited;
    assert.equal(code, 0, `Expected graceful exit, got ${code}/${signal}`);
  } finally {
    clearTimeout(timer);
  }
}

async function api(path, { method = 'GET', body, key, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  assert.ok(response.headers.get('x-request-id'));
  return data;
}

async function waitFor(id, status) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const payment = await api(`/payments/${id}`);
    if (payment.status !== 'processing') {
      assert.equal(payment.status, status);
      return payment;
    }
    await delay(25);
  }
  throw new Error('Payment did not finish');
}

try {
  await start(60000);
  assert.equal((await api('/health')).status, 'ok');
  const input = {
    amountMinor: 1050,
    currency: 'NGN',
    customerId: 'customer-1',
    merchantReference: 'order-1',
  };
  const payment = await api('/payments', {
    method: 'POST',
    body: input,
    key: 'smoke-success',
    expected: 201,
  });
  assert.equal(payment.status, 'processing');
  const replay = await api('/payments', {
    method: 'POST',
    body: input,
    key: 'smoke-success',
  });
  assert.equal(replay.id, payment.id);
  const declined = await api('/payments', {
    method: 'POST',
    body: { ...input, simulation: 'decline' },
    expected: 201,
  });
  const manual = await api('/payments', {
    method: 'POST',
    body: input,
    expected: 201,
  });
  const finalized = await api(`/payments/${manual.id}/status`, {
    method: 'PATCH',
    body: { status: 'failed' },
  });
  assert.equal(finalized.failureCode, 'MANUAL_FAILURE');
  await api(`/payments/${manual.id}/status`, {
    method: 'PATCH',
    body: { status: 'succeeded' },
    expected: 409,
  });
  await api('/payments', {
    method: 'POST',
    body: { ...input, amountMinor: 0 },
    expected: 400,
  });
  await stop();
  await start(10);
  await waitFor(payment.id, 'succeeded');
  assert.equal((await waitFor(declined.id, 'failed')).failureCode, 'DECLINED');
  const persistedReplay = await api('/payments', {
    method: 'POST',
    body: input,
    key: 'smoke-success',
  });
  assert.equal(persistedReplay.id, payment.id);
  assert.equal(persistedReplay.status, 'succeeded');
  assert.deepEqual(await api(`/payments/${manual.id}`), finalized);
  assert.equal((await api('/openapi.json')).openapi, '3.1.0');
  const docs = await fetch(`${base}/docs/`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /swagger-ui/);
  await stop();
  console.log(
    'Smoke passed: compiled server, create/get/update, success/decline, idempotency, restart recovery, docs, and graceful shutdown.',
  );
} finally {
  try {
    await stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
