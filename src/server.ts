import { readConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

const bootstrapLogger = createLogger();
try {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  const runtime = await createRuntime(config, logger, {
    onFatal: () => {
      process.exitCode = 1;
    },
    onShutdownTimeout: () => {
      // A stuck I/O handle must not extend the documented shutdown deadline.
      process.exit(1);
    },
  });
  const shutdown = () => {
    void runtime.stop().then(() => {
      process.exitCode = runtime.failed ? 1 : 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch {
  // Never log stored records, environment values, or raw validation exceptions.
  bootstrapLogger.fatal(
    { event: 'runtime.startup_failed' },
    'Startup failed. Check configuration, storage validity/permissions, and port availability.',
  );
  process.exitCode = 1;
}
