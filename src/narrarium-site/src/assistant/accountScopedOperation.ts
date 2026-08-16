let activeAccountScope: string | null = null;
const activeOperations = new Set<AbortController>();

function normalizeAccountScope(accountScope: string | null | undefined): string | null {
  return accountScope?.trim().toLocaleLowerCase() || null;
}

export function setAiOperationAccountScope(accountScope: string | null): void {
  const next = normalizeAccountScope(accountScope);
  if (next === activeAccountScope) return;
  for (const controller of activeOperations) controller.abort(new DOMException("The authenticated account changed.", "AbortError"));
  activeOperations.clear();
  activeAccountScope = next;
}

export function beginAccountScopedAiOperation(signal?: AbortSignal, accountScope?: string | null): {
  accountScope: string | null;
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const explicitScope = accountScope === undefined ? undefined : normalizeAccountScope(accountScope);
  if (explicitScope !== undefined && explicitScope !== activeAccountScope) {
    controller.abort(new DOMException("The AI operation belongs to a stale authenticated account.", "AbortError"));
    return { accountScope: explicitScope, signal: controller.signal, dispose: () => undefined };
  }
  const snapshot = explicitScope === undefined ? activeAccountScope : explicitScope;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  activeOperations.add(controller);
  return {
    accountScope: snapshot,
    signal: controller.signal,
    dispose: () => {
      activeOperations.delete(controller);
      signal?.removeEventListener("abort", abort);
    },
  };
}
