import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post, setToken, setUnauthorizedHandler, getToken } from './api.js';
import { hasPermission } from './permissions.js';

const AuthContext = createContext(null);
const COMPANIES_KEY = 'cognieos.companies';
const EMPTY = { loading: false, user: null, organization: null, company: null };

// Companies this person can switch to (names + codes only; switching asks for the password again)
function readCompanies() {
  try { return JSON.parse(sessionStorage.getItem(COMPANIES_KEY) || '[]'); } catch { return []; }
}
function saveCompanies(list) {
  try { sessionStorage.setItem(COMPANIES_KEY, JSON.stringify(list || [])); } catch { /* storage unavailable */ }
}

/** Loads the current session. Only an authentication failure ends it; network errors keep the token. */
function fetchSession(setState, logout) {
  return get('/auth/me')
    .then((me) => setState({ loading: false, user: me.user, organization: me.organization, company: me.company, connectionError: null }))
    .catch((err) => (err.status === 401 ? logout() : setState({ ...EMPTY, connectionError: err })));
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ ...EMPTY, loading: Boolean(getToken()) });
  const [companies, setCompanies] = useState(readCompanies);

  const logout = useCallback(() => {
    if (getToken()) post('/auth/logout').catch(() => {});
    setToken(null);
    saveCompanies([]);
    setCompanies([]);
    setState(EMPTY);
  }, []);

  const loadSession = useCallback(() => {
    setState((s) => ({ ...s, loading: true, connectionError: null }));
    fetchSession(setState, logout);
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(() => { setToken(null); setState(EMPTY); });
    if (getToken()) fetchSession(setState, logout);
  }, [logout]);

  const applySession = useCallback((res) => {
    setToken(res.token);
    if (res.companies) { saveCompanies(res.companies); setCompanies(res.companies); }
    setState({ loading: false, user: res.user, organization: res.organization, company: res.company });
    return res;
  }, []);

  /** Returns `{ requiresCompany, companies }` when the email belongs to several companies. */
  const login = useCallback(async (email, password, companyCode) => {
    const res = await post('/auth/login', { email, password, companyCode: companyCode || undefined });
    if (res.requiresCompany) return res;
    return applySession(res);
  }, [applySession]);

  const register = useCallback(async (data) => applySession(await post('/auth/register', data)), [applySession]);

  const switchCompany = useCallback(async (companyCode, password) => applySession(await post('/auth/switch-company', { companyCode, password })), [applySession]);

  const value = useMemo(() => ({
    ...state,
    companies,
    login,
    register,
    logout,
    switchCompany,
    // Registration shows its confirmation step first, then hands the session over
    startSession: applySession,
    refresh: loadSession,
    can: (permission) => hasPermission(state.user, permission),
    // Modules the company's current plan includes (core pages are always on)
    hasModule: (module) => !module || Boolean(state.company?.modules?.includes(module)),
  }), [state, companies, login, register, logout, switchCompany, applySession, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
