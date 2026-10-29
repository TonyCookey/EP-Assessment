import { readFile, writeFile } from 'node:fs/promises';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { atomicWrite, JsonRepository } from '../src/repository.js';
import { createRuntime } from '../src/runtime.js';
import type { Outcome } from '../src/processor.js';
import { deferred, input, quietLogger, temporaryStore } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('application lifecycle', () => {
  it('starts only after loading storage, reports readiness, and shuts down idempotently', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    const runtime = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
    );
    cleanups.push(runtime.stop);
    expect(runtime.ready()).toBe(false);
    await request(runtime.app).get('/health').expect(503);
    const server = await runtime.start(0);
    await request(server).get('/health').expect(200);
    await expect(runtime.start(0)).rejects.toThrow('once');
    const stopping = runtime.stop();
    expect(runtime.ready()).toBe(false);
    expect(runtime.stop()).toBe(stopping);
    await stopping;
    expect(server.listening).toBe(false);
    expect(runtime.failed).toBe(false);
  });
  it('cancels pending simulation and recovers it on the next runtime', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    const first = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      {
        simulator: (_payment, signal) =>
          new Promise<Outcome>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            );
          }),
      },
    );
    cleanups.push(first.stop);
    const server = await first.start(0);
    const created = await request(server)
      .post('/payments')
      .set('Idempotency-Key', 'resume')
      .send({ ...input, simulation: 'decline' })
      .expect(201);
    await first.stop();
    const simulator = vi.fn(async () => ({
      status: 'failed' as const,
      failureCode: 'DECLINED' as const,
    }));
    const second = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      { simulator },
    );
    cleanups.push(second.stop);
    await second.start(0);
    await second.processor.idle();
    expect(simulator).toHaveBeenCalledOnce();
    expect(second.service.get(created.body.id).failureCode).toBe('DECLINED');
    const replay = await second.service.create(
      { ...input, simulation: 'decline' },
      'resume',
    );
    expect(replay).toMatchObject({
      created: false,
      payment: { id: created.body.id, status: 'failed' },
    });
  });
  it('drains an active write before shutdown completes', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    const entered = deferred<void>();
    const gate = deferred<void>();
    let blocked = false;
    const runtime = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      {
        writer: async (file, contents) => {
          if (blocked) {
            entered.resolve();
            await gate.promise;
          }
          await atomicWrite(file, contents);
        },
      },
    );
    cleanups.push(runtime.stop);
    await runtime.start(0);
    blocked = true;
    const creation = runtime.service.create(input);
    await entered.promise;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    const { payment } = await creation;
    await stopping;
    expect(
      (await JsonRepository.open(files.file)).get(payment.id)?.status,
    ).toBe('processing');
  });
  it('returns 503 and shuts down after a storage error without acknowledging a failed commit', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    let fail = false;
    const fatal = vi.fn();
    const runtime = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      {
        onFatal: fatal,
        writer: async (file, contents) => {
          if (fail) throw new Error('disk full');
          await atomicWrite(file, contents);
        },
      },
    );
    cleanups.push(runtime.stop);
    const server = await runtime.start(0);
    fail = true;
    await request(server).post('/payments').send(input).expect(503);
    await runtime.stop();
    expect(fatal).toHaveBeenCalledOnce();
    expect(runtime.failed).toBe(true);
    expect(runtime.ready()).toBe(false);
    expect((await JsonRepository.open(files.file)).all()).toHaveLength(0);
  });
  it('stops on background storage failure and preserves the unfinished payment', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    let fail = false;
    const fatal = vi.fn();
    const runtime = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      {
        onFatal: fatal,
        simulator: async () => ({ status: 'succeeded' }),
        writer: async (file, contents) => {
          if (fail) throw new Error('disk full');
          await atomicWrite(file, contents);
        },
      },
    );
    cleanups.push(runtime.stop);
    await runtime.start(0);
    const { payment } = await runtime.service.create(input);
    fail = true;
    runtime.processor.schedule(payment);
    await runtime.processor.idle();
    await runtime.stop();
    expect(runtime.failed).toBe(true);
    expect(fatal).toHaveBeenCalledOnce();
    expect(
      (await JsonRepository.open(files.file)).get(payment.id)?.status,
    ).toBe('processing');
  });
  it('bounds shutdown when an injected processor ignores cancellation', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    const gate = deferred<Outcome>();
    const fatal = vi.fn();
    const runtime = await createRuntime(
      readConfig({ DATA_FILE: files.file }),
      quietLogger,
      { simulator: () => gate.promise, onFatal: fatal },
    );
    cleanups.push(runtime.stop);
    await runtime.start(0);
    const { payment } = await runtime.service.create(input);
    runtime.processor.schedule(payment);
    vi.useFakeTimers();
    const stopping = runtime.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(runtime.failed).toBe(true);
    expect(fatal).toHaveBeenCalledOnce();
    gate.resolve({ status: 'succeeded' });
    await runtime.processor.idle();
    expect(runtime.service.get(payment.id).status).toBe('processing');
  });
  it('rejects corrupt storage at startup without replacing it', async () => {
    const files = await temporaryStore();
    cleanups.push(files.cleanup);
    await writeFile(files.file, '{corrupt');
    await expect(
      createRuntime(readConfig({ DATA_FILE: files.file }), quietLogger),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readFile(files.file, 'utf8')).toBe('{corrupt');
  });
  it('cleans up when the requested listening port is already in use', async () => {
    const firstFiles = await temporaryStore();
    cleanups.push(firstFiles.cleanup);
    const secondFiles = await temporaryStore();
    cleanups.push(secondFiles.cleanup);
    const first = await createRuntime(
      readConfig({ DATA_FILE: firstFiles.file }),
      quietLogger,
    );
    cleanups.push(first.stop);
    const server = await first.start(0);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    const second = await createRuntime(
      readConfig({ DATA_FILE: secondFiles.file }),
      quietLogger,
    );
    cleanups.push(second.stop);
    await expect(second.start(address.port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(second.ready()).toBe(false);
  });
});
