import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { getSelectedTenant, getSession, type SessionInfo, setSelectedTenant } from './api.js';

interface AuthState {
  loading: boolean;
  session: SessionInfo | null;
  refresh: () => Promise<void>;
  /** Switches the organisation the UI works in. */
  selectTenant: (id: string) => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  session: null,
  refresh: async () => undefined,
  selectTenant: async () => undefined,
});

/**
 * Loads the session for the stored organisation. A stale selection (left, archived or from
 * another account) is dropped and the server's default organisation is used instead.
 */
async function loadSession(): Promise<SessionInfo | null> {
  let next = await getSession();
  if (next && !next.organisation && getSelectedTenant()) {
    setSelectedTenant(null);
    next = await getSession();
  }
  if (next?.organisation) setSelectedTenant(next.organisation.id);
  return next;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const refresh = useCallback(async () => {
    const next = await loadSession();
    setSession(next);
    setLoading(false);
  }, []);

  const selectTenant = useCallback(
    async (id: string) => {
      setSelectedTenant(id);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ loading, session, refresh, selectTenant }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
