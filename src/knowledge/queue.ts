import { compileConversation, compileSource } from './compiler.js';
import { isKnowledgeEnabled, logKnowledge } from '../storage/knowledge.js';
import { logWarn, shortId } from '../log.js';

const userChains = new Map<string, Promise<void>>();
const COMPILE_DEBOUNCE_MS = 8000;

export function enqueueSessionCompile(
  userId: string,
  conversationId: string,
): void {
  if (!isKnowledgeEnabled()) return;

  const prev = userChains.get(userId) ?? Promise.resolve();
  const next = prev
    .then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, COMPILE_DEBOUNCE_MS);
        }),
    )
    .then(async () => {
      logKnowledge('compile job started', {
        user: shortId(userId),
        conversationId,
      });
      await compileConversation(userId, conversationId);
    })
    .catch((err) => {
      logWarn('compile job failed', {
        user: shortId(userId),
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  userChains.set(userId, next);

  void next.finally(() => {
    if (userChains.get(userId) === next) {
      userChains.delete(userId);
    }
  });
}

export function enqueueAssetCompile(userId: string, sourceId: string): void {
  if (!isKnowledgeEnabled()) return;

  const prev = userChains.get(userId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      logKnowledge('asset compile job started', {
        user: shortId(userId),
        sourceId,
      });
      await compileSource(userId, sourceId);
    })
    .catch((err) => {
      logWarn('asset compile job failed', {
        user: shortId(userId),
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  userChains.set(userId, next);

  void next.finally(() => {
    if (userChains.get(userId) === next) {
      userChains.delete(userId);
    }
  });
}
