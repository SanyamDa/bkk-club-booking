/**
 * npm run admin:create -w @club/server -- --email a@b --name "X"
 *   Creates a platform admin. Prints a generated initial password and a TOTP otpauth URL once.
 *
 * npm run admin:create -w @club/server -- --email a@b --name "X" --club <slug> --role <role>
 *   Creates a member of that club with that role (owner, manager, host, door, promoter) and no TOTP.
 *
 * Stop the dev server first when using the embedded database: PGlite allows one process at a time.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clubMemberships, clubs, users, type MembershipRole } from '../db/schema.js';
import { newId } from '../lib/util.js';
import { generatePassword, hashPassword } from '../platform/passwords.js';
import { newTotpSecret, otpauthUrl } from '../platform/totp.js';

const ROLES: readonly MembershipRole[] = ['owner', 'manager', 'host', 'door', 'promoter'];

export interface CreatedAccount {
  userId: string;
  email: string;
  password: string;
  /** Null for a club member (no TOTP). */
  otpauthUrl: string | null;
}

export async function createAccount(db: Db, argv: string[]): Promise<CreatedAccount> {
  const { values } = parseArgs({
    args: argv,
    options: { email: { type: 'string' }, name: { type: 'string' }, club: { type: 'string' }, role: { type: 'string' } },
    strict: true,
  });
  const email = values.email?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('--email is required');
  if (!values.name) throw new Error('--name is required');
  if (Boolean(values.club) !== Boolean(values.role)) throw new Error('--club and --role go together');
  const role = values.role as MembershipRole | undefined;
  if (role && !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);

  const club = values.club ? await db.query.clubs.findFirst({ where: eq(clubs.slug, values.club) }) : undefined;
  if (values.club && !club) throw new Error(`No club with slug "${values.club}"`);
  if (await db.query.users.findFirst({ where: eq(users.email, email) })) throw new Error(`A user with email ${email} already exists`);

  const password = generatePassword();
  const isAdmin = !club;
  const totpSecret = isAdmin ? newTotpSecret() : null;
  const userId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      name: values.name!,
      passwordHash: await hashPassword(password),
      platformRole: isAdmin ? 'admin' : null,
      totpSecret,
    });
    if (club) await tx.insert(clubMemberships).values({ userId, clubId: club.id, role: role! });
  });
  return { userId, email, password, otpauthUrl: totpSecret ? otpauthUrl(totpSecret, email) : null };
}

async function main() {
  const dotenv = await import('dotenv');
  dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
  const { openDb } = await import('../db/client.js');
  const handle = await openDb({ url: process.env.DATABASE_URL || undefined, dataDir: process.env.DATA_DIR || '.data' });
  try {
    const out = await createAccount(handle.db, process.argv.slice(2));
    console.log(`\nCreated ${out.otpauthUrl ? 'platform admin' : 'club member'} ${out.email}`);
    console.log(`Initial password (shown once): ${out.password}`);
    if (out.otpauthUrl) {
      console.log(`TOTP (add to an authenticator app; shown once):\n  ${out.otpauthUrl}`);
      const QRCode = (await import('qrcode')).default;
      console.log(await QRCode.toString(out.otpauthUrl, { type: 'terminal', small: true }));
    }
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
