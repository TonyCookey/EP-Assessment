import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';
import {
  idempotencyKeySchema,
  paymentIdSchema,
  paymentInputSchema,
  statusUpdateSchema,
  validate,
} from './domain.js';
import { AppError, unavailable } from './errors.js';
import { openapi } from './openapi.js';
import type { PaymentProcessor } from './processor.js';
import type { PaymentService } from './service.js';

export interface AppDependencies {
  service: PaymentService;
  processor: Pick<PaymentProcessor, 'schedule' | 'cancel'>;
  logger: Logger;
  ready: () => boolean;
}

export function createApp({
  service,
  processor,
  logger,
  ready,
}: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const start = performance.now();
    res.on('finish', () => {
      // Route templates avoid logging identifiers, arbitrary URLs, or query strings.
      logger.info(
        {
          event: 'http.request',
          requestId,
          method: req.method,
          route:
            typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
          statusCode: res.statusCode,
          durationMs: Math.round((performance.now() - start) * 100) / 100,
        },
        'Request completed',
      );
    });
    next();
  });
  app.get('/health', (_req, res, next) => {
    if (!ready()) return next(unavailable());
    res.json({ status: 'ok' });
  });
  app.use((_req, _res, next) => next(ready() ? undefined : unavailable()));
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
  app.use((req, _res, next) => {
    if (
      ['POST', 'PATCH', 'PUT'].includes(req.method) &&
      !req.is('application/json')
    ) {
      return next(
        new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Use Content-Type: application/json.',
        ),
      );
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.post('/payments', async (req, res) => {
    const input = validate(paymentInputSchema, req.body);
    const keyValues = req.headersDistinct['idempotency-key'];
    if (keyValues && keyValues.length !== 1)
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Provide one Idempotency-Key header.',
      );
    const key = keyValues
      ? validate(idempotencyKeySchema, keyValues[0])
      : undefined;
    const result = await service.create(input, key);
    if (result.created) processor.schedule(result.payment);
    res
      .location(`/payments/${result.payment.id}`)
      .status(result.created ? 201 : 200)
      .json(result.payment);
  });
  app.get('/payments/:id', (req, res) => {
    const id = validate(paymentIdSchema, req.params.id);
    res.json(service.get(id));
  });
  app.patch('/payments/:id/status', async (req, res) => {
    const id = validate(paymentIdSchema, req.params.id);
    const { status } = validate(statusUpdateSchema, req.body);
    const payment = await service.finalize(id, status);
    processor.cancel(id);
    res.json(payment);
  });
  app.use((_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')),
  );

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    next,
  ) => {
    if (res.headersSent) return next(error);
    let mapped = error instanceof AppError ? error : undefined;
    if (error instanceof URIError) {
      mapped = new AppError(
        400,
        'INVALID_PATH_PARAMETER',
        'The URL contains an invalid encoded parameter.',
      );
    }
    const type =
      error && typeof error === 'object' && 'type' in error
        ? error.type
        : undefined;
    if (type === 'entity.parse.failed')
      mapped = new AppError(
        400,
        'INVALID_JSON',
        'The request body is not valid JSON.',
      );
    if (type === 'entity.too.large')
      mapped = new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        'The request body exceeds 16 KiB.',
      );
    if (type === 'charset.unsupported' || type === 'encoding.unsupported')
      mapped = new AppError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Unsupported request encoding.',
      );
    if (!mapped) {
      logger.error(
        { event: 'http.error', requestId: res.locals.requestId },
        'Unexpected request failure',
      );
      mapped = new AppError(
        500,
        'INTERNAL_ERROR',
        'An unexpected error occurred.',
      );
    }
    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId: res.locals.requestId,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
    });
  };
  app.use(errorHandler);
  return app;
}
