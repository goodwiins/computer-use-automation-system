import type { UIMessage } from 'ai';

export class ChatRequestError extends Error {}

// Keep user IDs: the server reconstructs prior run context from caller-scoped journal keys.
// Client tool payloads are display-only. The latest stable ID is also its request key.
export function chatRequest(messages: UIMessage[], id: string, intent: 'invoke' | 'status' = 'invoke') {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const text = (message: UIMessage) =>
    message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  if (!latestUser || !text(latestUser).length)
    throw new ChatRequestError('Enter a text request. No request was sent.');
  if (latestUser.parts.some((part) => part.type !== 'text') || text(latestUser).length > 4000)
    throw new ChatRequestError(
      'Your request must contain only text and at most 4000 characters. Review your operation facts before shortening it. No request was sent.',
    );
  if (id.length > 200 || !/^[\x21-\x7e]{1,200}$/.test(latestUser.id))
    throw new ChatRequestError(
      'Invalid conversation or request identity. Reconnect before sending. No request was sent.',
    );

  let current:
    | { id: string; role: 'user' | 'assistant'; parts: { type: 'text'; text: string }[] }
    | undefined;
  const history = messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (!message.id.length || message.id.length > 200) return [];
    let content = text(message);
    if (message.role === 'assistant') content = content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '');
    if (!content.length || content.length > 4000) return [];
    const entry = { id: message.id, role: message.role, parts: [{ type: 'text' as const, text: content }] };
    if (message === latestUser) current = entry;
    return [entry];
  });
  const body = { id, intent, messages: history, trigger: 'submit-message' as const };
  const bytes = () => new TextEncoder().encode(JSON.stringify(body)).byteLength;
  while (history.length > 20 || bytes() > 32 * 1024) {
    const oldest = history.findIndex((message) => message !== current);
    if (oldest < 0)
      throw new ChatRequestError(
        'Your request exceeds the transport limit. Review your operation facts before shortening it. No request was sent.',
      );
    history.splice(oldest, 1);
  }
  return { headers: { 'Idempotency-Key': latestUser.id }, body };
}
