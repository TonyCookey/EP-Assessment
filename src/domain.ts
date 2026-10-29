import { z } from 'zod';
import { AppError } from './errors.js';

const identifier = z.string().trim().min(1).max(128);
export const paymentInputSchema = z.strictObject({
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(['NGN', 'USD', 'EUR']),
  customerId: identifier,
  merchantReference: identifier,
  description: z.string().trim().max(500).optional(),
  simulation: z.enum(['success', 'decline']).default('success'),
});
export const statusUpdateSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed']),
});
export const paymentIdSchema = z.uuid();
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
export const failureCodeSchema = z.enum([
  'DECLINED',
  'MANUAL_FAILURE',
  'PROCESSING_ERROR',
]);
export const paymentSchema = paymentInputSchema
  .extend({
    id: paymentIdSchema,
    status: z.enum(['processing', 'succeeded', 'failed']),
    failureCode: failureCodeSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (payment) =>
      (payment.status === 'failed') === (payment.failureCode !== null) &&
      Date.parse(payment.updatedAt) >= Date.parse(payment.createdAt),
    'Invalid payment lifecycle fields',
  );

export type PaymentInput = z.infer<typeof paymentInputSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type FinalStatus = z.infer<typeof statusUpdateSchema>['status'];
export type FailureCode = z.infer<typeof failureCodeSchema>;

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The request is invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        // Unknown keys may themselves contain sensitive input. Do not echo them.
        message:
          issue.code === 'unrecognized_keys'
            ? 'Unknown fields are not allowed.'
            : issue.message,
      })),
    );
  }
  return result.data;
}

// Explicit field order makes fingerprints independent of JSON property order.
export function fingerprint(input: PaymentInput): string {
  return JSON.stringify([
    input.amountMinor,
    input.currency,
    input.customerId,
    input.merchantReference,
    input.description ?? null,
    input.simulation,
  ]);
}

export function inputOf(payment: Payment): PaymentInput {
  return paymentInputSchema.parse({
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    customerId: payment.customerId,
    merchantReference: payment.merchantReference,
    ...(payment.description === undefined
      ? {}
      : { description: payment.description }),
    simulation: payment.simulation,
  });
}
