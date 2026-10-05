import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Light / dark / system theme. Applies `.dark` on <html>; the choice is remembered per browser.
 * index.html sets the class before React loads, so there is no flash of the wrong theme.
 */
const KEY = 'cognieos.theme';
const ThemeContext = createContext({ theme: 'system', resolvedTheme: 'light', setTheme: () => {} });

function readStored() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);
  const [systemIsDark, setSystemIsDark] = useState(systemDark);
  const resolvedTheme = theme === 'system' ? (systemIsDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = (e) => setSystemIsDark(e.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
