import { createHash } from 'node:crypto';

const normalize = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function fingerprintMessage(message) {
  const messageId = normalize(message.messageId).replace(/^<|>$/g, '');
  if (messageId) return `message-id:${messageId}`;
  const content = [message.from, message.subject, message.sentAt, message.body].map(normalize).join('\0');
  return `content:${createHash('sha256').update(content).digest('hex')}`;
}

