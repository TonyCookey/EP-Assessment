import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { FailureCode, FinalStatus, Payment } from './domain.js';
import { AppError, StorageError } from './errors.js';
import type { PaymentService } from './service.js';

export type Outcome = { status: FinalStatus; failureCode?: FailureCode };
export type Simulator = (
  payment: Payment,
  signal: AbortSignal,
) => Promise<Outcome>;

export function createSimulator(
  delayMs: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) =>
    delay(ms, undefined, { signal }),
): Simulator {
  return async (payment, signal) => {
    await sleep(delayMs, signal);
    return payment.simulation === 'decline'
      ? { status: 'failed', failureCode: 'DECLINED' }
      : { status: 'succeeded' };
  };
}

export class PaymentProcessor {
  private stopped = false;
  private readonly jobs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();

  constructor(
    private readonly service: PaymentService,
    private readonly simulator: Simulator,
    private readonly logger: Logger,
    private readonly onFatal: () => void,
  ) {}

  schedule(payment: Payment): void {
    if (
      this.stopped ||
      this.jobs.has(payment.id) ||
      payment.status !== 'processing'
    )
      return;
    const controller = new AbortController();
    const done = this.run(payment, controller.signal)
      .catch(() => {
        this.logger.error(
          { event: 'processor.fatal', paymentId: payment.id },
          'Background processing could not persist its result',
        );
        this.onFatal();
      })
      .finally(() => {
        this.jobs.delete(payment.id);
      });
    this.jobs.set(payment.id, { controller, done });
  }

  recover(): void {
    const pending = this.service.processing();
    this.logger.info(
      { event: 'processor.recovery', count: pending.length },
      'Resuming unfinished payments',
    );
    pending.forEach((payment) => this.schedule(payment));
  }

  cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await this.idle();
  }

  async idle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }

  private async run(payment: Payment, signal: AbortSignal): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = await this.simulator(payment, signal);
    } catch {
      if (signal.aborted) return;
      this.logger.error(
        { event: 'processor.error', paymentId: payment.id },
        'Unexpected simulator error',
      );
      outcome = { status: 'failed', failureCode: 'PROCESSING_ERROR' };
    }
    if (signal.aborted) return;
    try {
      await this.service.finalize(
        payment.id,
        outcome.status,
        outcome.failureCode,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'STATUS_CONFLICT') {
        this.logger.debug(
          { event: 'processor.superseded', paymentId: payment.id },
          'Payment was already finalized',
        );
        return;
      }
      if (error instanceof StorageError)
        this.logger.error(
          { event: 'storage.failure' },
          'Payment storage unavailable',
        );
      throw error;
    }
  }
}
