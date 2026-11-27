import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations, type Conversation } from '../db/schema.js';

/** A conversation by id, only when it belongs to this club. */
export async function getConversationForClub(db: Db, clubId: string, id: string): Promise<Conversation | undefined> {
  return db.query.conversations.findFirst({ where: and(eq(conversations.clubId, clubId), eq(conversations.id, id)) });
}
