export interface ChatMessageLike {
  role: string;
  content: string;
}

export interface ChatTurnLike {
  capturedAt: Date;
  messages: ChatMessageLike[];
}

function messageKey(message: ChatMessageLike) {
  return `${message.role}\u0000${message.content.trim().replace(/\s+/g, " ")}`;
}

function dedupeAdjacent<T extends ChatMessageLike>(messages: T[]) {
  const deduped: T[] = [];
  let previousKey: string | null = null;

  for (const message of messages) {
    if (!message.content.trim()) continue;

    const key = messageKey(message);
    if (key === previousKey) continue;

    deduped.push(message);
    previousKey = key;
  }

  return deduped;
}

function suffixPrefixOverlap(existingKeys: string[], candidateKeys: string[]) {
  const maxLength = Math.min(existingKeys.length, candidateKeys.length);

  for (let length = maxLength; length > 0; length -= 1) {
    const existingStart = existingKeys.length - length;
    let matches = true;

    for (let index = 0; index < length; index += 1) {
      if (existingKeys[existingStart + index] !== candidateKeys[index]) {
        matches = false;
        break;
      }
    }

    if (matches) return length;
  }

  return 0;
}

function chooseBestOrientation<T extends ChatMessageLike>(
  existingKeys: string[],
  messages: T[]
) {
  const forwardKeys = messages.map(messageKey);
  const reversedMessages = messages.slice().reverse();
  const reversedKeys = reversedMessages.map(messageKey);

  const forwardOverlap = suffixPrefixOverlap(existingKeys, forwardKeys);
  const reversedOverlap = suffixPrefixOverlap(existingKeys, reversedKeys);

  if (reversedOverlap > forwardOverlap) {
    return {
      messages: reversedMessages,
      keys: reversedKeys,
      overlap: reversedOverlap,
    };
  }

  return {
    messages,
    keys: forwardKeys,
    overlap: forwardOverlap,
  };
}

function forwardOverlap(existingKeys: string[], messages: ChatMessageLike[]) {
  return suffixPrefixOverlap(existingKeys, messages.map(messageKey));
}

export function getNewMessagesFromSnapshot<TMessage extends ChatMessageLike>(
  existingMessages: ChatMessageLike[],
  snapshotMessages: TMessage[]
) {
  const cleanedMessages = dedupeAdjacent(snapshotMessages);
  if (!cleanedMessages.length) return [];

  const existingKeys = existingMessages.map(messageKey);
  const overlap = forwardOverlap(existingKeys, cleanedMessages);
  const recentKeys = new Set(existingKeys.slice(-20));
  const addedMessages: TMessage[] = [];

  for (let index = overlap; index < cleanedMessages.length; index += 1) {
    const message = cleanedMessages[index];
    const key = messageKey(message);

    if (recentKeys.has(key)) continue;

    addedMessages.push(message);
  }

  return addedMessages;
}

export function mergeOverlappingChatTurns<TTurn extends ChatTurnLike>(
  turns: TTurn[]
) {
  const orderedTurns = turns
    .slice()
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

  const mergedTurns: TTurn[] = [];
  const mergedKeys: string[] = [];

  for (const turn of orderedTurns) {
    const messages = dedupeAdjacent(turn.messages);
    if (!messages.length) continue;

    const candidate = chooseBestOrientation(mergedKeys, messages);
    const recentKeys = new Set(mergedKeys.slice(-20));
    const addedMessages: typeof messages = [];

    for (let index = candidate.overlap; index < candidate.messages.length; index += 1) {
      const message = candidate.messages[index];
      const key = candidate.keys[index];

      if (recentKeys.has(key)) continue;

      addedMessages.push(message);
      mergedKeys.push(key);
    }

    if (addedMessages.length) {
      mergedTurns.push({ ...turn, messages: addedMessages });
    }
  }

  return mergedTurns;
}
