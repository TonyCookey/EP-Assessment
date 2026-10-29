const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: json(ref('Error')),
});
const paymentResponse = (description: string) => ({
  description,
  headers: {
    'X-Request-Id': {
      description: 'Server-generated request UUID',
      schema: { type: 'string', format: 'uuid' },
    },
  },
  content: json(ref('Payment')),
});
const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const inputProperties = {
  amountMinor: {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'Integer minor units; 1050 represents 10.50.',
  },
  currency: { type: 'string', enum: ['NGN', 'USD', 'EUR'] },
  customerId: identifier,
  merchantReference: {
    ...identifier,
    description: 'Business reference; repeated references are allowed.',
  },
  description: { type: 'string', maxLength: 500 },
  simulation: {
    type: 'string',
    enum: ['success', 'decline'],
    default: 'success',
  },
};
const requiredInput = [
  'amountMinor',
  'currency',
  'customerId',
  'merchantReference',
];
const example = {
  amountMinor: 1050,
  currency: 'NGN',
  customerId: 'customer-1',
  merchantReference: 'order-1',
  simulation: 'success',
};
const idParameter = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const commonErrors = {
  '400': errorResponse('Invalid request'),
  '500': errorResponse('Unexpected internal failure'),
  '503': errorResponse('Service or storage unavailable'),
};
const bodyErrors = {
  '413': errorResponse('Body exceeds 16 KiB'),
  '415': errorResponse('JSON content type and supported encoding required'),
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Payment Processing Simulation',
    version: '1.0.0',
    description:
      'Local, unauthenticated simulation. No real payments. One process owns the JSON file. Amounts use minor units. Text is trimmed and unknown input fields are rejected. Every response includes X-Request-Id.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/payments': {
      post: {
        operationId: 'createPayment',
        summary: 'Create a payment for asynchronous processing',
        description:
          'The persisted processing record is returned immediately. Simulation takes two seconds by default. Same-key retries with equivalent normalized input return the current payment; conflicting reuse returns 409. Keys do not expire.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern: '^[!-~]+$',
            },
            description:
              'Case-sensitive visible ASCII; exactly one header value.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('PaymentInput'),
              examples: {
                success: { value: example },
                decline: { value: { ...example, simulation: 'decline' } },
              },
            },
          },
        },
        responses: {
          '201': {
            ...paymentResponse('Created; initial status is processing'),
            headers: {
              ...paymentResponse('').headers,
              Location: {
                schema: { type: 'string' },
                description: 'Relative payment resource URL',
              },
            },
          },
          '200': {
            ...paymentResponse('Idempotent replay; current persisted state'),
            headers: {
              ...paymentResponse('').headers,
              Location: { schema: { type: 'string' } },
            },
          },
          '409': errorResponse('Idempotency key reused with different input'),
          ...commonErrors,
          ...bodyErrors,
        },
      },
    },
    '/payments/{id}': {
      get: {
        operationId: 'getPayment',
        summary: 'Retrieve a payment',
        parameters: [idParameter],
        responses: {
          '200': paymentResponse('Current persisted payment'),
          '404': errorResponse('Payment not found'),
          ...commonErrors,
        },
      },
    },
    '/payments/{id}/status': {
      patch: {
        operationId: 'updatePaymentStatus',
        summary: 'Manually finalize a payment',
        description:
          'First committed final result wins. Repeating that final status is a no-op, including timestamps and failure code. A different final status returns 409. Manual failure uses MANUAL_FAILURE.',
        parameters: [idParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('StatusUpdate'),
              example: { status: 'failed' },
            },
          },
        },
        responses: {
          '200': paymentResponse('Final payment'),
          '404': errorResponse('Payment not found'),
          '409': errorResponse('Conflicting final status'),
          ...commonErrors,
          ...bodyErrors,
        },
      },
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Readiness',
        responses: {
          '200': {
            description: 'Ready',
            content: json({
              type: 'object',
              required: ['status'],
              additionalProperties: false,
              properties: { status: { const: 'ok' } },
            }),
          },
          '503': errorResponse(
            'Not ready; may be unreachable once listener closes',
          ),
        },
      },
    },
    '/docs': {
      get: {
        operationId: 'docs',
        summary: 'Swagger UI (redirects to /docs/)',
        responses: {
          '301': {
            description: 'Redirect to documentation with trailing slash',
          },
          '200': { description: 'Swagger UI HTML' },
          '503': errorResponse('Not ready'),
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'OpenAPI 3.1 document',
        responses: {
          '200': {
            description: 'API contract',
            content: json({ type: 'object' }),
          },
          '503': errorResponse('Not ready'),
        },
      },
    },
  },
  components: {
    schemas: {
      PaymentInput: {
        type: 'object',
        additionalProperties: false,
        required: requiredInput,
        properties: inputProperties,
      },
      Payment: {
        type: 'object',
        additionalProperties: false,
        required: [
          ...requiredInput,
          'simulation',
          'id',
          'status',
          'failureCode',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          ...inputProperties,
          id: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['processing', 'succeeded', 'failed'],
          },
          failureCode: {
            type: ['string', 'null'],
            enum: [null, 'DECLINED', 'MANUAL_FAILURE', 'PROCESSING_ERROR'],
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        allOf: [
          {
            if: { properties: { status: { const: 'failed' } } },
            then: { properties: { failureCode: { type: 'string' } } },
            else: { properties: { failureCode: { type: 'null' } } },
          },
        ],
      },
      StatusUpdate: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['succeeded', 'failed'] },
        },
      },
      Error: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              requestId: { type: 'string', format: 'uuid' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['field', 'message'],
                  properties: {
                    field: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
