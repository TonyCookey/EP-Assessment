import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  fingerprint,
  type FailureCode,
  type FinalStatus,
  type Payment,
  type PaymentInput,
} from './domain.js';
import { AppError } from './errors.js';
import type { JsonRepository } from './repository.js';

export class PaymentService {
  constructor(
    private readonly repository: JsonRepository,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    input: PaymentInput,
    key?: string,
  ): Promise<{ payment: Payment; created: boolean }> {
    const result = await this.repository.transact((draft) => {
      if (key !== undefined) {
        const existing = draft.idempotency.find((entry) => entry.key === key);
        if (existing) {
          if (fingerprint(existing.input) !== fingerprint(input)) {
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This idempotency key was used for a different request.',
            );
          }
          const payment = draft.payments.find(
            (entry) => entry.id === existing.paymentId,
          )!;
          return { value: { payment, created: false }, changed: false };
        }
      }
      const timestamp = this.now().toISOString();
      const payment: Payment = {
        ...input,
        id: randomUUID(),
        status: 'processing',
        failureCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      draft.payments.push(payment);
      if (key !== undefined)
        draft.idempotency.push({
          key,
          paymentId: payment.id,
          input: structuredClone(input),
        });
      return { value: { payment, created: true }, changed: true };
    });
    if (result.created)
      this.logger.info(
        {
          event: 'payment.created',
          paymentId: result.payment.id,
          status: result.payment.status,
        },
        'Payment created',
      );
    return result;
  }

  get(id: string): Payment {
    const payment = this.repository.get(id);
    if (!payment)
      throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    return payment;
  }

  processing(): Payment[] {
    return this.repository
      .all()
      .filter((payment) => payment.status === 'processing');
  }

  async finalize(
    id: string,
    status: FinalStatus,
    failureCode: FailureCode = 'MANUAL_FAILURE',
  ): Promise<Payment> {
    const result = await this.repository.transact((draft) => {
      const payment = draft.payments.find((entry) => entry.id === id);
      if (!payment)
        throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      if (payment.status === status)
        return { value: { payment, transitioned: false }, changed: false };
      if (payment.status !== 'processing') {
        throw new AppError(
          409,
          'STATUS_CONFLICT',
          'A final payment status cannot be changed.',
        );
      }
      payment.status = status;
      payment.failureCode = status === 'failed' ? failureCode : null;
      payment.updatedAt = new Date(
        Math.max(this.now().getTime(), Date.parse(payment.createdAt)),
      ).toISOString();
      return { value: { payment, transitioned: true }, changed: true };
    });
    if (result.transitioned) {
      this.logger.info(
        {
          event: 'payment.finalized',
          paymentId: id,
          status,
          failureCode: result.payment.failureCode,
        },
        'Payment finalized',
      );
    }
    return result.payment;
  }
}
