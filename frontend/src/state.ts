import type { Selection, ResolvedPaper, VerificationVerdict } from './types';

type Listener = (sel: Selection | null) => void;

/** Shared selection and review data store. */
export function createStore() {
  let current: Selection | null = null;
  let resolvedMap = new Map<string, ResolvedPaper>();
  let verdictsMap = new Map<string, VerificationVerdict>();
  const listeners: Set<Listener> = new Set();

  return {
    get(): Selection | null {
      return current;
    },
    set(sel: Selection | null): void {
      current = sel;
      for (const fn of listeners) fn(sel);
    },
    setResolvedMap(map: Map<string, ResolvedPaper>): void {
      resolvedMap = map;
    },
    getResolved(anchorId: string): ResolvedPaper | null {
      return resolvedMap.get(anchorId) ?? null;
    },
    setVerdictsMap(map: Map<string, VerificationVerdict>): void {
      verdictsMap = map;
    },
    getVerdict(claimId: string, anchorId: string): VerificationVerdict | null {
      return verdictsMap.get(`${claimId}:${anchorId}`) ?? null;
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
