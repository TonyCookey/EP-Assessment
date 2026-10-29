import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSimulator,
  PaymentProcessor,
  type Outcome,
} from '../src/processor.js';
import { JsonRepository } from '../src/repository.js';
import { PaymentService } from '../src/service.js';
import { deferred, fixture, input, quietLogger } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('asynchronous processing', () => {
  it.each(['success', 'decline'] as const)(
    'runs the saved %s scenario after a controlled delay',
    async (simulation) => {
      const f = await fixture();
      cleanups.push(f.cleanup);
      const { payment } = await f.service.create({ ...input, simulation });
      const gate = deferred<void>();
      const sleep = vi.fn(() => gate.promise);
      const fatal = vi.fn();
      const processor = new PaymentProcessor(
        f.service,
        createSimulator(2000, sleep),
        quietLogger,
        fatal,
      );
      processor.schedule(payment);
      expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
      expect(f.service.get(payment.id).status).toBe('processing');
      gate.resolve();
      await processor.idle();
      expect(f.service.get(payment.id)).toMatchObject(
        simulation === 'success'
          ? { status: 'succeeded', failureCode: null }
          : { status: 'failed', failureCode: 'DECLINED' },
      );
      expect(fatal).not.toHaveBeenCalled();
    },
  );
  it('catches unexpected simulator rejection and persists a processing error', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const processor = new PaymentProcessor(
      f.service,
      async () => {
        throw new Error('provider broke');
      },
      quietLogger,
      vi.fn(),
    );
    processor.schedule(payment);
    await processor.idle();
    expect(f.service.get(payment.id)).toMatchObject({
      status: 'failed',
      failureCode: 'PROCESSING_ERROR',
    });
  });
  it('does not overwrite a manual result when automatic completion races it', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const outcome = deferred<Outcome>();
    const fatal = vi.fn();
    const processor = new PaymentProcessor(
      f.service,
      () => outcome.promise,
      quietLogger,
      fatal,
    );
    processor.schedule(payment);
    await f.service.finalize(payment.id, 'failed');
    outcome.resolve({ status: 'succeeded' });
    await processor.idle();
    expect(f.service.get(payment.id).failureCode).toBe('MANUAL_FAILURE');
    expect(fatal).not.toHaveBeenCalled();
  });
  it('recovers only unfinished records, deduplicates scheduling, and repeats the full delay', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const pending = (
      await f.service.create({ ...input, simulation: 'decline' })
    ).payment;
    const finished = (await f.service.create(input)).payment;
    await f.service.finalize(finished.id, 'succeeded');
    const reopened = await JsonRepository.open(f.file);
    const service = new PaymentService(reopened, quietLogger);
    const gate = deferred<void>();
    const sleep = vi.fn(() => gate.promise);
    const processor = new PaymentProcessor(
      service,
      createSimulator(2000, sleep),
      quietLogger,
      vi.fn(),
    );
    processor.recover();
    processor.schedule(pending);
    processor.schedule(service.get(finished.id));
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    gate.resolve();
    await processor.idle();
    expect(service.get(pending.id).failureCode).toBe('DECLINED');
    expect(service.get(finished.id).status).toBe('succeeded');
  });
  it('cancels waiting work on shutdown and leaves it recoverable', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const simulator = vi.fn(
      (_payment, signal: AbortSignal) =>
        new Promise<Outcome>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const processor = new PaymentProcessor(
      f.service,
      simulator,
      quietLogger,
      vi.fn(),
    );
    processor.schedule(payment);
    await processor.stop();
    processor.schedule(payment);
    expect(simulator).toHaveBeenCalledOnce();
    expect(f.service.get(payment.id).status).toBe('processing');
  });
  it('suppresses a resolved outcome after cancellation', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    const gate = deferred<Outcome>();
    const processor = new PaymentProcessor(
      f.service,
      () => gate.promise,
      quietLogger,
      vi.fn(),
    );
    processor.schedule(payment);
    processor.cancel(payment.id);
    gate.resolve({ status: 'succeeded' });
    await processor.idle();
    expect(f.service.get(payment.id).status).toBe('processing');
  });
  it('reports a fatal failure if a background result cannot be persisted', async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const { payment } = await f.service.create(input);
    vi.spyOn(f.service, 'finalize').mockRejectedValue(
      new Error('write failed'),
    );
    const fatal = vi.fn();
    const processor = new PaymentProcessor(
      f.service,
      async () => ({ status: 'succeeded' }),
      quietLogger,
      fatal,
    );
    processor.schedule(payment);
    await processor.idle();
    expect(fatal).toHaveBeenCalledOnce();
  });
});
