import pino, { type DestinationStream } from 'pino';

export function createLogger(level = 'info', destination?: DestinationStream) {
  const options = {
    level,
    base: null,
    redact: [
      'customerId',
      'merchantReference',
      'idempotencyKey',
      'body',
      'headers',
    ],
  };
  return destination ? pino(options, destination) : pino(options);
}
