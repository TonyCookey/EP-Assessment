import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  idempotencyKeySchema,
  paymentInputSchema,
  validate,
} from '../src/domain.js';
import { readConfig } from '../src/config.js';
import { input } from './helpers.js';

describe('payment input', () => {
  it('normalizes text and defaults the scenario without coercing amounts', () => {
    const parsed = paymentInputSchema.parse({
      ...input,
      simulation: undefined,
      customerId: ' customer-1 ',
      description: ' hello ',
    });
    expect(parsed).toMatchObject({
      customerId: 'customer-1',
      description: 'hello',
      simulation: 'success',
    });
  });
  it.each([
    0,
    -1,
    1.5,
    '1050',
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
    null,
  ])('rejects amount %s', (amountMinor) => {
    expect(
      paymentInputSchema.safeParse({ ...input, amountMinor }).success,
    ).toBe(false);
  });
  it.each([
    { currency: 'GBP' },
    { currency: 'ngn' },
    { customerId: ' ' },
    { merchantReference: '' },
    { customerId: 'x'.repeat(129) },
    { merchantReference: 'x'.repeat(129) },
    { description: 'x'.repeat(501) },
    { simulation: 'random' },
    { status: 'succeeded' },
  ])('rejects invalid fields %j', (changes) => {
    expect(paymentInputSchema.safeParse({ ...input, ...changes }).success).toBe(
      false,
    );
  });
  it('accepts all documented currencies and safe integer boundary', () => {
    for (const currency of ['NGN', 'USD', 'EUR']) {
      expect(
        paymentInputSchema.parse({
          ...input,
          currency,
          amountMinor: Number.MAX_SAFE_INTEGER,
        }).currency,
      ).toBe(currency);
    }
  });
  it('fingerprints normalized fields independent of property order', () => {
    const { simulation: _simulation, ...withoutScenario } = input;
    expect(
      fingerprint(
        paymentInputSchema.parse({
          ...withoutScenario,
          customerId: ' customer-1 ',
        }),
      ),
    ).toBe(fingerprint(input));
    expect(fingerprint({ ...input, description: '' })).not.toBe(
      fingerprint(input),
    );
  });
  it.each(['', 'has space', 'é', '\n', 'x'.repeat(129)])(
    'rejects invalid key %j',
    (key) => {
      expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
    },
  );
  it('does not echo unknown field names in validation errors', () => {
    expect(() =>
      validate(paymentInputSchema, { ...input, secret: true }),
    ).toThrow('The request is invalid');
    try {
      validate(paymentInputSchema, { ...input, secret: true });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret');
    }
  });
});

describe('configuration', () => {
  it('uses documented defaults', () => {
    expect(readConfig({})).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      simulationDelayMs: 2000,
      logLevel: 'info',
    });
  });
  it('accepts explicit valid settings', () => {
    expect(
      readConfig({
        HOST: '0.0.0.0',
        PORT: '8080',
        SIMULATION_DELAY_MS: '0',
        DATA_FILE: '/tmp/payments.json',
        LOG_LEVEL: 'debug',
      }),
    ).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      simulationDelayMs: 0,
      dataFile: '/tmp/payments.json',
      logLevel: 'debug',
    });
  });
  it.each([
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '1.5' },
    { SIMULATION_DELAY_MS: '-1' },
    { SIMULATION_DELAY_MS: '2147483648' },
    { LOG_LEVEL: 'nope' },
    { HOST: ' ' },
    { DATA_FILE: '' },
  ])('rejects invalid environment %j', (env) => {
    expect(() => readConfig(env)).toThrow('Invalid configuration');
  });
});
