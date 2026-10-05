import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post, setToken, setUnauthorizedHandler, getToken } from './api.js';
import { hasPermission } from './permissions.js';

const AuthContext = createContext(null);

/** Loads the current session. Only an authentication failure ends it; network errors keep the token. */
function fetchSession(setState, logout) {
  return get('/auth/me')
    .then((me) => setState({ loading: false, user: me.user, organization: me.organization, connectionError: null }))
    .catch((err) => (err.status === 401 ? logout() : setState({ loading: false, user: null, organization: null, connectionError: err })));
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: Boolean(getToken()), user: null, organization: null });

  const logout = useCallback(() => {
    setToken(null);
    setState({ loading: false, user: null, organization: null });
  }, []);

  const loadSession = useCallback(() => {
    setState((s) => ({ ...s, loading: true, connectionError: null }));
    fetchSession(setState, logout);
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (getToken()) fetchSession(setState, logout);
  }, [logout]);

  const login = useCallback(async (email, password) => {
    const res = await post('/auth/login', { email, password });
    setToken(res.token);
    setState({ loading: false, user: res.user, organization: res.organization });
  }, []);

  const register = useCallback(async (data) => {
    const res = await post('/auth/register', data);
    setToken(res.token);
    setState({ loading: false, user: res.user, organization: res.organization });
  }, []);

  const value = useMemo(() => ({
    ...state,
    login,
    register,
    logout,
    refresh: loadSession,
    can: (permission) => hasPermission(state.user, permission),
  }), [state, login, register, logout, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
