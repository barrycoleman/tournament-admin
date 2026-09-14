import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiRequest } from "./api-client";
import {
  clearStoredTokens,
  getStoredTokens,
  storeTokens,
  tokensFromLoginResponse,
  type StoredTokens,
} from "./tokenStorage";
import { refreshTokens } from "./refresh";
import { decodeAccessTokenPayload } from "./jwt";

/** How long before expiry the silent-refresh timer fires. */
const REFRESH_MARGIN_MS = 30_000;

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface AuthState {
  isAuthenticated: boolean;
  role: string | null;
}

interface AuthContextValue extends AuthState {
  login: (role: string, password: string, label?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function stateFromTokens(tokens: StoredTokens | null): AuthState {
  if (!tokens) return { isAuthenticated: false, role: null };
  try {
    const payload = decodeAccessTokenPayload(tokens.accessToken);
    return { isAuthenticated: true, role: payload.role };
  } catch {
    return { isAuthenticated: false, role: null };
  }
}

/** Synchronous, context-free check for router loaders (outside the React tree). */
export function hasValidTokens(): boolean {
  return getStoredTokens() !== null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => stateFromTokens(getStoredTokens()));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(
    (tokens: StoredTokens) => {
      clearTimer();
      const delay = Math.max(tokens.expiresAt - Date.now() - REFRESH_MARGIN_MS, 0);
      timerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const next = await refreshTokens();
            setState(stateFromTokens(next));
            scheduleRefresh(next);
          } catch {
            setState({ isAuthenticated: false, role: null });
          }
        })();
      }, delay);
    },
    [clearTimer]
  );

  useEffect(() => {
    const tokens = getStoredTokens();
    if (tokens) {
      scheduleRefresh(tokens);
    }
    return clearTimer;
    // Runs once on mount only — scheduleRefresh/clearTimer are stable
    // useCallback references that would otherwise cause a lint warning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (role: string, password: string, label?: string) => {
      const response = await apiRequest<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: { role, password, label },
      });
      const tokens = tokensFromLoginResponse(response);
      storeTokens(tokens);
      setState(stateFromTokens(tokens));
      scheduleRefresh(tokens);
    },
    [scheduleRefresh]
  );

  const logout = useCallback(async () => {
    const tokens = getStoredTokens();
    clearTimer();
    if (tokens) {
      try {
        await apiRequest<void>("/api/auth/logout", {
          method: "POST",
          body: { refresh_token: tokens.refreshToken },
        });
      } catch {
        // Best-effort server-side revocation. The user is logged out
        // locally regardless — see the spec's "Explicit logout" section.
      }
    }
    clearStoredTokens();
    setState({ isAuthenticated: false, role: null });
  }, [clearTimer]);

  const value = useMemo(() => ({ ...state, login, logout }), [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
