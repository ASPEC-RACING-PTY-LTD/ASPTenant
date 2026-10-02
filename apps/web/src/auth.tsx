import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { getSession, type SessionInfo } from './api.js';

interface AuthState {
  loading: boolean;
  session: SessionInfo | null;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  session: null,
  refresh: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const refresh = async () => {
    const next = await getSession();
    setSession(next);
    setLoading(false);
  };

  useEffect(() => {
    void getSession().then((next) => {
      setSession(next);
      setLoading(false);
    });
  }, []);

  return (
    <AuthContext.Provider value={{ loading, session, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
