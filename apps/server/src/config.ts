import { z } from 'zod';

const schema = z.object({
  API_PORT: z.coerce.number().int().default(8787),
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  DATA_DIR: z.string().default('.data'),
  APP_SECRET: z.string().min(16, 'APP_SECRET must be at least 16 characters'),
  STAFF_PASSWORD: z.string().min(4, 'STAFF_PASSWORD must be at least 4 characters'),
  DEV_SIMULATOR: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}\nCopy apps/server/.env.example to apps/server/.env and fill it in.`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_SIMULATOR) {
    throw new Error('DEV_SIMULATOR must not be enabled in production.');
  }
  return parsed.data;
}
