import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { openapi } from '../src/openapi.js';
import { atomicWrite } from '../src/repository.js';
import { fixture, input } from './helpers.js';

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema({ $id: 'api', ...openapi });
const paymentContract = ajv.compile({
  $ref: 'api#/components/schemas/Payment',
});
const errorContract = ajv.compile({ $ref: 'api#/components/schemas/Error' });
const inputContract = ajv.compile({
  $ref: 'api#/components/schemas/PaymentInput',
});

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.cleanup();
});

describe('HTTP payment API', () => {
  it('creates and retrieves a processing payment with documented headers and schema', async () => {
    const response = await request(f.app)
      .post('/payments')
      .send(input)
      .expect(201);
    expect(
      paymentContract(response.body),
      JSON.stringify(paymentContract.errors),
    ).toBe(true);
    expect(response.body.status).toBe('processing');
    expect(response.headers.location).toBe(`/payments/${response.body.id}`);
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(f.scheduled).toEqual([response.body.id]);
    const fetched = await request(f.app)
      .get(`/payments/${response.body.id}`)
      .expect(200);
    expect(fetched.body).toEqual(response.body);
  });
  it('replays normalized requests in the current state without rescheduling', async () => {
    const response = await request(f.app)
      .post('/payments')
      .set('Idempotency-Key', 'same')
      .send(input)
      .expect(201);
    await request(f.app)
      .patch(`/payments/${response.body.id}/status`)
      .send({ status: 'succeeded' })
      .expect(200);
    const { simulation: _scenario, ...withoutScenario } = input;
    const replay = await request(f.app)
      .post('/payments')
      .set('Idempotency-Key', 'same')
      .send({ ...withoutScenario, customerId: ' customer-1 ' })
      .expect(200);
    expect(replay.body).toMatchObject({
      id: response.body.id,
      status: 'succeeded',
    });
    expect(f.scheduled).toHaveLength(1);
    await request(f.app)
      .post('/payments')
      .set('Idempotency-Key', 'same')
      .send({ ...input, currency: 'USD' })
      .expect(409);
  });
  it('returns one 201 and remaining 200s for concurrent duplicate HTTP requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(f.app)
          .post('/payments')
          .set('Idempotency-Key', 'concurrent')
          .send(input),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(5);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
  });
  it('allows repeated references and independent requests without keys', async () => {
    const first = await request(f.app)
      .post('/payments')
      .send(input)
      .expect(201);
    const second = await request(f.app)
      .post('/payments')
      .send(input)
      .expect(201);
    expect(first.body.id).not.toBe(second.body.id);
  });
  it('finalizes manually, repeats the same result, and rejects conflicting transitions', async () => {
    const created = await request(f.app)
      .post('/payments')
      .send(input)
      .expect(201);
    const path = `/payments/${created.body.id}/status`;
    const final = await request(f.app)
      .patch(path)
      .send({ status: 'failed' })
      .expect(200);
    expect(final.body.failureCode).toBe('MANUAL_FAILURE');
    expect(paymentContract(final.body)).toBe(true);
    expect(
      (await request(f.app).patch(path).send({ status: 'failed' }).expect(200))
        .body,
    ).toEqual(final.body);
    await request(f.app).patch(path).send({ status: 'succeeded' }).expect(409);
    await request(f.app).patch(path).send({ status: 'processing' }).expect(400);
    await request(f.app)
      .patch(path)
      .send({ status: 'failed', amountMinor: 1 })
      .expect(400);
  });
  it.each([
    { amountMinor: '100' },
    { currency: 'JPY' },
    { customerId: '' },
    { merchantReference: ' ' },
    { unknown: 1 },
  ])('returns contract-compliant validation errors for %j', async (changes) => {
    const response = await request(f.app)
      .post('/payments')
      .send({ ...input, ...changes })
      .expect(400);
    expect(
      errorContract(response.body),
      JSON.stringify(errorContract.errors),
    ).toBe(true);
    expect(response.body.error.requestId).toBe(
      response.headers['x-request-id'],
    );
    expect(response.body.error.details.length).toBeGreaterThan(0);
  });
  it('handles malformed JSON, oversized input, and unsupported media types', async () => {
    const malformed = await request(f.app)
      .post('/payments')
      .type('json')
      .send('{oops')
      .expect(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
    expect(errorContract(malformed.body)).toBe(true);
    await request(f.app)
      .post('/payments')
      .send({ ...input, description: 'a'.repeat(17000) })
      .expect(413);
    await request(f.app)
      .post('/payments')
      .type('text')
      .send('hello')
      .expect(415);
    await request(f.app)
      .post('/payments')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send('{}')
      .expect(415);
  });
  it('rejects invalid and repeated idempotency headers', async () => {
    await request(f.app)
      .post('/payments')
      .set('Idempotency-Key', 'has space')
      .send(input)
      .expect(400);
    await request(f.app)
      .post('/payments')
      .set('Idempotency-Key', 'x'.repeat(129))
      .send(input)
      .expect(400);
    await request(f.app)
      .post('/payments')
      .set({ 'Idempotency-Key': ['first', 'second'] })
      .send(input)
      .expect(400);
  });
  it('distinguishes malformed IDs from absent payments and unknown routes', async () => {
    await request(f.app).get('/payments/not-a-uuid').expect(400);
    await request(f.app).get('/payments/%E0%A4%A').expect(400);
    await request(f.app).get(`/payments/${randomUUID()}`).expect(404);
    await request(f.app)
      .patch(`/payments/${randomUUID()}/status`)
      .send({ status: 'failed' })
      .expect(404);
    await request(f.app).get('/not-found').expect(404);
  });
  it('serves health, Swagger UI, and OpenAPI with executable request examples', async () => {
    expect((await request(f.app).get('/health').expect(200)).body).toEqual({
      status: 'ok',
    });
    const spec = await request(f.app).get('/openapi.json').expect(200);
    expect(spec.body).toEqual(openapi);
    await request(f.app)
      .get('/docs/')
      .expect(200)
      .expect('Content-Type', /html/);
    for (const { value } of Object.values(
      openapi.paths['/payments'].post.requestBody.content['application/json']
        .examples,
    )) {
      expect(inputContract(value)).toBe(true);
      const response = await request(f.app)
        .post('/payments')
        .send(value)
        .expect(201);
      expect(paymentContract(response.body)).toBe(true);
    }
  });
  it('returns 503 on a failed write and on subsequent readiness checks', async () => {
    let fail = false;
    const failing = await fixture({
      writer: async (file, contents) => {
        if (fail) throw new Error('disk full');
        await atomicWrite(file, contents);
      },
    });
    try {
      fail = true;
      const response = await request(failing.app)
        .post('/payments')
        .send(input)
        .expect(503);
      expect(errorContract(response.body)).toBe(true);
      await request(failing.app).get('/health').expect(503);
    } finally {
      await failing.cleanup();
    }
  });
  it('sanitizes unexpected errors and omits sensitive values from all request logs', async () => {
    const lines: string[] = [];
    const logger = createLogger('debug', {
      write: (line) => {
        lines.push(line);
      },
    });
    const app = createApp({
      service: f.service,
      logger,
      ready: () => true,
      processor: { schedule: () => {}, cancel: () => {} },
    });
    await request(app)
      .post('/payments?private=secret-query')
      .set('Idempotency-Key', 'secret-key')
      .send({
        ...input,
        customerId: 'secret-customer',
        merchantReference: 'secret-reference',
      })
      .expect(201);
    vi.spyOn(f.service, 'get').mockImplementation(() => {
      throw new Error('secret-internal');
    });
    const response = await request(app)
      .get(`/payments/${randomUUID()}`)
      .expect(500);
    expect(response.body.error.message).toBe('An unexpected error occurred.');
    const logs = lines.join('');
    expect(logs).not.toContain('secret-');
    expect(logs).toContain('requestId');
    expect(logs).toContain('durationMs');
    expect(errorContract(response.body)).toBe(true);
  });
});
