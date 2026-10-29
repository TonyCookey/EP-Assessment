import { resolve } from 'node:path';
import { z } from 'zod';

const integer = (fallback: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const configSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: integer('3000', 1, 65535),
  DATA_FILE: z.string().trim().min(1).default('data/payments.json'),
  SIMULATION_DELAY_MS: integer('2000', 0, 2147483647),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  return {
    host: result.data.HOST,
    port: result.data.PORT,
    dataFile: resolve(result.data.DATA_FILE),
    simulationDelayMs: result.data.SIMULATION_DELAY_MS,
    logLevel: result.data.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof readConfig>;
