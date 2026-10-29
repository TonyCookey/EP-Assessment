import { readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicWrite, JsonRepository } from '../src/repository.js';
import { PaymentService } from '../src/service.js';
import {
  deferred,
  fixture,
  input,
  quietLogger,
  temporaryStore,
} from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('JSON repository and payment transactions', () => {
  it('persists payments and keys, reloads them, and exposes isolated copies', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const created = await f.service.create(input, 'key-1');
    created.payment.customerId = 'modified-outside';
    expect(f.service.get(created.payment.id).customerId).toBe(input.customerId);
    const reopened = await JsonRepository.open(f.file);
    const replay = await new PaymentService(reopened, quietLogger).create(
      input,
      'key-1',
    );
    expect(replay.created).toBe(false);
    expect(replay.payment.id).toBe(created.payment.id);
    expect(await readdir(f.directory)).toEqual(['payments.json']);
  });
  it('serializes concurrent duplicate creations into exactly one payment', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.service.create(input, 'same-key')),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.payment.id)).size).toBe(1);
    expect(f.repository.all()).toHaveLength(1);
  });
  it('rejects conflicting key reuse but keeps the transaction queue usable', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    await f.service.create(input, 'key');
    await expect(
      f.service.create({ ...input, amountMinor: 2 }, 'key'),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.service.create(input, 'Key')).created).toBe(true);
    expect((await f.service.create(input)).created).toBe(true);
    expect(f.repository.all()).toHaveLength(3);
  });
  it('serializes conflicting finalizations and keeps repeated finalizations unchanged', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const results = await Promise.allSettled([
      f.service.finalize(payment.id, 'failed'),
      f.service.finalize(payment.id, 'succeeded'),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'STATUS_CONFLICT' },
    });
    const final = f.service.get(payment.id);
    expect(final.failureCode).toBe('MANUAL_FAILURE');
    expect(await f.service.finalize(payment.id, 'failed', 'DECLINED')).toEqual(
      final,
    );
  });
  it('does not publish uncommitted state and drains writes before resolving', async () => {
    const gate = deferred<void>();
    let block = false;
    const f = await fixture({
      writer: async (file, contents) => {
        if (block) await gate.promise;
        await atomicWrite(file, contents);
      },
    });
    cleanups.push(f.cleanup);
    block = true;
    const pending = f.service.create(input);
    await Promise.resolve();
    expect(f.repository.all()).toHaveLength(0);
    let drained = false;
    const drain = f.repository.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await pending;
    await drain;
    expect(f.repository.all()).toHaveLength(1);
  });
  it('preserves the committed file and trips health once on failed writes', async () => {
    let fail = false;
    const onFailure = vi.fn();
    const f = await fixture({
      onFailure,
      writer: async (file, contents) => {
        if (fail) throw new Error('disk full');
        await atomicWrite(file, contents);
      },
    });
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input, 'key');
    const before = await readFile(f.file, 'utf8');
    fail = true;
    await expect(
      f.service.finalize(payment.id, 'succeeded'),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readFile(f.file, 'utf8')).toBe(before);
    expect(f.repository.healthy).toBe(false);
    expect(() => f.repository.all()).toThrow('storage');
    await expect(f.service.create(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(onFailure).toHaveBeenCalledOnce();
    const recovered = await JsonRepository.open(f.file);
    expect(recovered.get(payment.id)?.status).toBe('processing');
  });
  it.each([
    '{broken',
    '{"schemaVersion":2,"payments":[],"idempotency":[]}',
    '{"schemaVersion":1,"payments":[],"idempotency":[{"key":"x","paymentId":"00000000-0000-4000-8000-000000000000","input":{}}]}',
  ])(
    'fails startup without replacing corrupt or unsupported content',
    async (content) => {
      const f = await temporaryStore();
      cleanups.push(f.cleanup);
      await writeFile(f.file, content);
      await expect(JsonRepository.open(f.file)).rejects.toMatchObject({
        status: 503,
      });
      expect(await readFile(f.file, 'utf8')).toBe(content);
    },
  );
  it('rejects duplicate IDs and noncanonical stored data', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const state = {
      schemaVersion: 1,
      payments: [payment, payment],
      idempotency: [],
    };
    await writeFile(f.file, JSON.stringify(state));
    await expect(JsonRepository.open(f.file)).rejects.toMatchObject({
      status: 503,
    });
    state.payments = [{ ...payment, customerId: ' padded ' }];
    await writeFile(f.file, JSON.stringify(state));
    await expect(JsonRepository.open(f.file)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('leaves the original file intact and removes temp files when replacement fails', async () => {
    const f = await temporaryStore();
    cleanups.push(f.cleanup);
    // Replacing a directory with a regular file fails on supported OSes.
    await expect(atomicWrite(f.directory, 'new')).rejects.toBeDefined();
    expect(await readdir(f.directory)).toEqual([]);
  });
});
