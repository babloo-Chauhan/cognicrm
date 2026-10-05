import { useEffect, useRef, useState } from 'react';

/**
 * Runs an async loader whenever `deps` change and tracks loading / error / data.
 * Previous data stays visible while reloading. `reload()` re-runs the loader.
 */
export function useAsync(loader, deps = []) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ key: null, data: null, error: null });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const key = `${JSON.stringify(deps)}#${tick}`;
  useEffect(() => {
    let alive = true;
    loaderRef.current().then(
      (data) => alive && setState({ key, data, error: null }),
      (error) => alive && setState((s) => ({ key, data: s.data, error })),
    );
    return () => { alive = false; };
  }, [key]);
  return {
    loading: state.key !== key,
    data: state.data,
    error: state.key === key ? state.error : null,
    reload: () => setTick((t) => t + 1),
    setData: (data) => setState((s) => ({ ...s, data })),
  };
}
