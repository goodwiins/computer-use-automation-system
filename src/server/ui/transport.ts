import type { UIMessage } from 'ai';

// The SDK can retry the same message. Its stable ID is also the server request key.
export function chatRequest(messages: UIMessage[], id: string) {
  const history = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts
        .filter((p) => p.type === 'text' && p.text.length > 0)
        .map((p) => ({ type: 'text' as const, text: p.type === 'text' ? p.text : '' })),
    }))
    .filter((m) => m.parts.length > 0)
    .slice(-20);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new Error('A user text message is required');
  return {
    headers: { 'Idempotency-Key': lastUser.id },
    body: { id, messages: history, trigger: 'submit-message' as const },
  };
}
