import type { ChatwootClient } from './provision.js';

/**
 * Chatwoot account API calls the LINE bridge makes (plan A14), on top of A13's `ChatwootClient`.
 * Every call takes the token it runs as: the club's platform admin user for contacts, conversations,
 * guest messages and dashboard staff replies; the Agent Bot token for bot messages, so Chatwoot shows
 * them as the bot. Shapes follow Chatwoot CE v4 and are not checked against a live install.
 */

export type ChatwootMessageType = 'incoming' | 'outgoing';
export type ChatwootStatus = 'open' | 'pending' | 'resolved';

type ContactResponse = {
  id?: number;
  payload?: { id?: number; contact?: { id: number; contact_inboxes?: { source_id: string }[] }; contact_inbox?: { source_id?: string } };
};

export function chatwootAccount(cw: ChatwootClient, accountId: number, token: string) {
  const base = `/api/v1/accounts/${accountId}`;
  return {
    /** Creates the contact in the API inbox. Returns its id and the inbox source id Chatwoot gave it. */
    async createContact(input: { inboxId: number; identifier: string; name: string }): Promise<{ contactId: number; sourceId: string | null }> {
      const res = await cw.request<ContactResponse>(
        'POST',
        `${base}/contacts`,
        { inbox_id: input.inboxId, identifier: input.identifier, name: input.name },
        token,
      );
      const contactId = res.payload?.contact?.id ?? res.payload?.id ?? res.id;
      if (!contactId) throw new Error('Chatwoot returned no contact id');
      const sourceId = res.payload?.contact_inbox?.source_id ?? res.payload?.contact?.contact_inboxes?.[0]?.source_id ?? null;
      return { contactId, sourceId };
    },
    /** The contact with this identifier, if one exists. */
    async searchContact(identifier: string): Promise<number | null> {
      const res = await cw.request<{ payload?: { id: number; identifier?: string | null }[] }>(
        'GET',
        `${base}/contacts/search?q=${encodeURIComponent(identifier)}`,
        undefined,
        token,
      );
      return res.payload?.find((c) => c.identifier === identifier)?.id ?? null;
    },
    async createContactInbox(contactId: number, inboxId: number, sourceId: string): Promise<string> {
      const res = await cw.request<{ source_id?: string }>(
        'POST',
        `${base}/contacts/${contactId}/contact_inboxes`,
        { inbox_id: inboxId, source_id: sourceId },
        token,
      );
      return res.source_id ?? sourceId;
    },
    async createConversation(input: { inboxId: number; contactId: number; sourceId: string; status: ChatwootStatus }): Promise<number> {
      const res = await cw.request<{ id: number }>(
        'POST',
        `${base}/conversations`,
        { inbox_id: input.inboxId, contact_id: input.contactId, source_id: input.sourceId, status: input.status },
        token,
      );
      return res.id;
    },
    async createMessage(conversationId: number, input: { content: string; messageType: ChatwootMessageType }): Promise<number> {
      const res = await cw.request<{ id: number }>(
        'POST',
        `${base}/conversations/${conversationId}/messages`,
        { content: input.content, message_type: input.messageType, private: false },
        token,
      );
      return res.id;
    },
    async toggleStatus(conversationId: number, status: ChatwootStatus): Promise<void> {
      await cw.request('POST', `${base}/conversations/${conversationId}/toggle_status`, { status }, token);
    },
    /** Points the API inbox's outgoing webhook (staff replies) at `url`. */
    async setInboxWebhook(inboxId: number, url: string): Promise<void> {
      await cw.request('PATCH', `${base}/inboxes/${inboxId}`, { channel: { webhook_url: url } }, token);
    },
  };
}

export type ChatwootAccount = ReturnType<typeof chatwootAccount>;
