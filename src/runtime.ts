import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import type { Config } from './config.js';
import {
  createSimulator,
  PaymentProcessor,
  type Simulator,
} from './processor.js';
import { JsonRepository, type AtomicWriter } from './repository.js';
import { PaymentService } from './service.js';

export async function createRuntime(
  config: Config,
  logger: Logger,
  options: {
    writer?: AtomicWriter;
    simulator?: Simulator;
    graceMs?: number;
    onFatal?: () => void;
    onShutdownTimeout?: () => void;
  } = {},
) {
  let state: 'starting' | 'ready' | 'stopping' | 'stopped' = 'starting';
  let failed = false;
  let shutdown: Promise<void> | undefined;
  let server: Server | undefined;
  const fail = () => {
    if (failed) return;
    failed = true;
    logger.fatal(
      { event: 'runtime.failure' },
      'Service stopping after a fatal background or storage failure',
    );
    options.onFatal?.();
    // Allow the failing HTTP operation to emit its 503 before closing the listener.
    setImmediate(() => {
      void stop();
    });
  };
  const repository = await JsonRepository.open(config.dataFile, {
    ...(options.writer ? { writer: options.writer } : {}),
    onFailure: fail,
  });
  const service = new PaymentService(repository, logger);
  const processor = new PaymentProcessor(
    service,
    options.simulator ?? createSimulator(config.simulationDelayMs),
    logger,
    fail,
  );
  const ready = () => state === 'ready' && !failed && repository.healthy;
  const app = createApp({ service, processor, logger, ready });

  async function start(port = config.port) {
    if (state !== 'starting')
      throw new Error('Runtime can only be started once');
    server = createServer(app);
    const listener = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        listener.once('error', onError);
        listener.listen(port, config.host, () => {
          listener.off('error', onError);
          resolve();
        });
      });
      listener.on('error', fail);
      state = 'ready';
      processor.recover();
      const address = listener.address();
      logger.info(
        {
          event: 'runtime.ready',
          host: config.host,
          port: typeof address === 'object' ? address?.port : port,
        },
        'Payment service ready',
      );
      return listener;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  function stop(): Promise<void> {
    if (shutdown) return shutdown;
    state = 'stopping';
    logger.info({ event: 'runtime.stopping' }, 'Stopping payment service');
    const closed = new Promise<void>((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
    shutdown = (async () => {
      let timeout: NodeJS.Timeout | undefined;
      const drained = Promise.all([closed, processor.stop()]).then(() =>
        repository.drain(),
      );
      const timedOut = await Promise.race([
        drained.then(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(true), options.graceMs ?? 5000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        logger.error(
          { event: 'runtime.shutdown_timeout' },
          'Shutdown grace period expired',
        );
        failed = true;
        server?.closeAllConnections();
        options.onFatal?.();
      }
      state = 'stopped';
      logger.info({ event: 'runtime.stopped' }, 'Payment service stopped');
      if (timedOut) options.onShutdownTimeout?.();
    })();
    return shutdown;
  }

  return {
    app,
    service,
    processor,
    repository,
    ready,
    start,
    stop,
    get failed() {
      return failed;
    },
  };
}
