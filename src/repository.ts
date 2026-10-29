import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  fingerprint,
  idempotencyKeySchema,
  inputOf,
  paymentInputSchema,
  paymentSchema,
  type Payment,
} from './domain.js';
import { StorageError } from './errors.js';

const storedInputSchema = paymentInputSchema.required({ simulation: true });
const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    payments: z.array(paymentSchema),
    idempotency: z.array(
      z.strictObject({
        key: idempotencyKeySchema,
        paymentId: z.uuid(),
        input: storedInputSchema,
      }),
    ),
  })
  .superRefine((state, ctx) => {
    const payments = new Map(
      state.payments.map((payment) => [payment.id, payment]),
    );
    const keys = new Set(state.idempotency.map((entry) => entry.key));
    const invalid =
      payments.size !== state.payments.length ||
      keys.size !== state.idempotency.length ||
      state.idempotency.some((entry) => {
        const payment = payments.get(entry.paymentId);
        return (
          !payment || fingerprint(entry.input) !== fingerprint(inputOf(payment))
        );
      });
    if (invalid)
      ctx.addIssue({ code: 'custom', message: 'Invalid storage references' });
  });

export type StoreState = z.infer<typeof stateSchema>;
export type AtomicWriter = (file: string, contents: string) => Promise<void>;

export async function atomicWrite(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class JsonRepository {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;

  private constructor(
    private readonly file: string,
    private state: StoreState,
    private readonly writer: AtomicWriter,
    private readonly onFailure: () => void,
  ) {}

  static async open(
    file: string,
    options: { writer?: AtomicWriter; onFailure?: () => void } = {},
  ) {
    const writer = options.writer ?? atomicWrite;
    let state: StoreState;
    try {
      let contents: string;
      try {
        contents = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = { schemaVersion: 1, payments: [], idempotency: [] };
        await mkdir(dirname(file), { recursive: true });
        await writer(file, JSON.stringify(state, null, 2) + '\n');
        return new JsonRepository(
          file,
          state,
          writer,
          options.onFailure ?? (() => {}),
        );
      }
      const parsed: unknown = JSON.parse(contents);
      state = stateSchema.parse(parsed);
      // Validation must not silently normalize or fill defaults in stored data.
      if (JSON.stringify(parsed) !== JSON.stringify(state)) {
        // Property order is irrelevant; compare canonicalized structures instead.
        if (canonical(parsed) !== canonical(state))
          throw new Error('Noncanonical stored fields');
      }
    } catch {
      throw new StorageError();
    }
    return new JsonRepository(
      file,
      state,
      writer,
      options.onFailure ?? (() => {}),
    );
  }

  get healthy() {
    return !this.failed;
  }

  all(): Payment[] {
    this.assertHealthy();
    return structuredClone(this.state.payments);
  }

  get(id: string): Payment | undefined {
    this.assertHealthy();
    const payment = this.state.payments.find((entry) => entry.id === id);
    return payment && structuredClone(payment);
  }

  transact<T>(
    change: (draft: StoreState) => { value: T; changed: boolean },
  ): Promise<T> {
    const operation = this.tail.then(async () => {
      this.assertHealthy();
      const draft = structuredClone(this.state);
      const { value, changed } = change(draft);
      if (changed) {
        // Rule failures are not storage outages. Only persistence failures trip health.
        stateSchema.parse(draft);
        try {
          await this.writer(this.file, JSON.stringify(draft, null, 2) + '\n');
        } catch {
          this.failed = true;
          this.onFailure();
          throw new StorageError();
        }
        this.state = draft;
      }
      return structuredClone(value);
    });
    // A rejected domain operation must not poison the serialization queue.
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async drain() {
    await this.tail;
  }

  private assertHealthy() {
    if (this.failed) throw new StorageError();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
