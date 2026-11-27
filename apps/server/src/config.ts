import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The placeholder APP_SECRET shipped in .env.example; never accepted. */
export const EXAMPLE_APP_SECRET = 'change-me-to-a-long-random-string';

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  API_PORT: z.coerce.number().int().default(8787),
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: optionalString,
  DATA_DIR: z.string().default('.data'),
  APP_SECRET: z
    .string()
    .min(32, 'APP_SECRET must be at least 32 characters')
    .refine((v) => v !== EXAMPLE_APP_SECRET, 'APP_SECRET is still the example value; generate a real one'),
  /** base64 of 32 bytes. Required unless NODE_ENV is development or test. */
  CREDENTIALS_KEY: optionalString,
  /** Optional until Phase 2. */
  ANTHROPIC_API_KEY: optionalString,
  DEV_SIMULATOR: flag,
  /** Fake LINE token issuer and setup clients (development and test only). */
  LINE_FAKE: flag,
  NODE_ENV: z.string().default('development'),
});

export type Config = Omit<z.infer<typeof schema>, 'CREDENTIALS_KEY'> & {
  /** 32-byte AES key for club credentials. */
  CREDENTIALS_KEY: Buffer;
};

export function isDevOrTest(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}\nCopy apps/server/.env.example to apps/server/.env and fill it in.`);
  }
  const data = parsed.data;
  const devOrTest = isDevOrTest(data.NODE_ENV);
  // The only place that holds the "development or test only" rule (B8 relies on it).
  if (!devOrTest && data.DEV_SIMULATOR) {
    throw new Error(`DEV_SIMULATOR must only be enabled when NODE_ENV is development or test (got ${data.NODE_ENV}).`);
  }
  if (!devOrTest && data.LINE_FAKE) {
    throw new Error(`LINE_FAKE must only be enabled when NODE_ENV is development or test (got ${data.NODE_ENV}).`);
  }

  let key: Buffer;
  if (data.CREDENTIALS_KEY) {
    key = Buffer.from(data.CREDENTIALS_KEY, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be base64 of exactly 32 bytes.');
  } else if (devOrTest) {
    key = createHash('sha256').update('credentials:' + data.APP_SECRET).digest();
  } else {
    throw new Error(`CREDENTIALS_KEY is required when NODE_ENV is ${data.NODE_ENV}.`);
  }

  return { ...data, CREDENTIALS_KEY: key };
}
