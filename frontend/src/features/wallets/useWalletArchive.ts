import { useCallback, useEffect, useState } from 'react';
import { getWalletArchive, WalletArchiveData, WalletArchiveQuery } from '../../utils/walletApi';

export function useWalletArchive(query: WalletArchiveQuery) {
  const [data, setData] = useState<WalletArchiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const key = JSON.stringify(query);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(null);
    Promise.resolve(getWalletArchive(JSON.parse(key), controller.signal)).then(result => { if (active) setData(result); })
      .catch(() => { if (active) setError('Non è stato possibile caricare l’archivio. Riprova.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [key, revision]);
  useEffect(() => {
    window.addEventListener('data-sync-complete', refresh);
    return () => window.removeEventListener('data-sync-complete', refresh);
  }, [refresh]);
  return { data, loading, error, refresh };
}
