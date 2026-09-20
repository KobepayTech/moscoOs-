/**
 * Load data for a screen.
 *
 * Small on purpose. The app has one loading pattern — fetch on focus, pull to
 * refresh, show the error rather than a blank screen — and a hook is cheaper
 * to understand than a data library for something this size.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refreshing: boolean;
  /** Pull-to-refresh: keeps the current data on screen while reloading. */
  refresh: () => Promise<void>;
  /** Full reload, clearing what is shown. */
  reload: () => Promise<void>;
  /** Replace the data locally, e.g. after an action returns fresh state. */
  set: (value: T) => void;
}

export function useAsync<T>(load: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // A screen can unmount while a request is in flight; setting state then
  // warns in development and leaks in production.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);

      try {
        const result = await load();
        if (!alive.current) return;
        setData(result);
        setError(null);
      } catch (problem) {
        if (!alive.current) return;
        setError(
          problem instanceof ApiError ? problem : new ApiError(0, (problem as Error).message ?? 'Failed'),
        );
      } finally {
        if (alive.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [load],
  );

  useEffect(() => {
    void run('initial');
  }, [run]);

  return {
    data,
    error,
    loading,
    refreshing,
    refresh: useCallback(() => run('refresh'), [run]),
    reload: useCallback(() => run('initial'), [run]),
    set: setData,
  };
}
