import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { paymentInputSchema } from '../src/domain.js';
import { JsonRepository, type AtomicWriter } from '../src/repository.js';
import { PaymentService } from '../src/service.js';

export const input = paymentInputSchema.parse({
  amountMinor: 1050,
  currency: 'NGN',
  customerId: 'customer-1',
  merchantReference: 'order-1',
});
export const quietLogger = createLogger('silent');

export async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), 'payment-test-'));
  return {
    directory,
    file: join(directory, 'payments.json'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function fixture(
  options: { writer?: AtomicWriter; onFailure?: () => void } = {},
) {
  const files = await temporaryStore();
  const repository = await JsonRepository.open(files.file, options);
  const service = new PaymentService(repository, quietLogger);
  const scheduled: string[] = [];
  const app = createApp({
    service,
    logger: quietLogger,
    ready: () => repository.healthy,
    processor: {
      schedule: (payment) => {
        scheduled.push(payment.id);
      },
      cancel: () => {},
    },
  });
  return { ...files, repository, service, app, scheduled };
}
