import { useCallback, useEffect, useState } from 'react';
import '../../features/wallets/wallets.css';
import { getManualModelOpportunities } from '../../utils/modelBetActionsApi';
import ModelBadge from '../../features/wallets/ModelBadge';
import { fmtSelection } from './predictionFormatting';

export default function SavedModelOpportunities({ matchId, family = 'all', from, to }: {
  matchId?: string; family?: 'all' | 'A' | 'C'; from?: string | null; to?: string | null;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const entries = await getManualModelOpportunities();
      if (!Array.isArray(entries)) throw new Error('Archivio non valido.');
      setRows(entries);
    }
    catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = () => { void refresh(); };
    window.addEventListener('model-opportunity-archived', listener);
    return () => window.removeEventListener('model-opportunity-archived', listener);
  }, [refresh]);
  const visible = rows.filter((row) => (!matchId || row.matchId === matchId) && (family === 'all' || row.family === family)
    && (!from || Date.parse(row.createdAt) >= Date.parse(from)) && (!to || Date.parse(row.createdAt) <= Date.parse(to)));
  return <section className="pr-card app-wallet-section" aria-label="Opportunità archiviate senza puntata">
    <h2>Opportunità archiviate senza puntata</h2><p>Selezioni LOW o speculative conservate per consultazione; nessun capitale è impegnato.</p>
    {loading ? <p role="status">Caricamento opportunità archiviate…</p> : error ? <p role="alert">Archivio delle opportunità non disponibile. <button type="button" className="fp-btn fp-btn-ghost" onClick={() => void refresh()}>Riprova archivio opportunità</button></p>
      : !visible.length ? <p>Nessuna opportunità archiviata nei filtri scelti.</p> : visible.map((row) => <article key={row.id} className="app-wallet-bet">
        <ModelBadge model={row.family} /><h3>{row.snapshot?.matchLabel || row.matchId}</h3>
        <strong>{fmtSelection(row.selection)}</strong><p>{row.classification} · {new Date(row.createdAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}</p>
        <p>Quota conservata: {typeof row.snapshot?.quote?.odds === 'number' ? row.snapshot.quote.odds.toFixed(2) : 'Non disponibile'} · {row.snapshot?.quote?.bookmaker || 'Bookmaker non disponibile'}</p>
      </article>)}
  </section>;
}
