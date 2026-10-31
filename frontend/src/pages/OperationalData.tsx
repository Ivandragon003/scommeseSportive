import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getOperationalStatus, OperationalStatus, refreshMatchResults } from '../utils/api';
import './operational-data.css';

const dateTime = (value: string | null | undefined): string => {
  if (!value || !/(?:z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return 'Non disponibile';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(new Date(value));
};
const nightlyLabel = (state: OperationalStatus['nightly']['state']): string => ({
  SUCCESS: 'Ultima elaborazione completata', FAILED: 'Ultima elaborazione non riuscita',
  RUNNING: 'Elaborazione in corso', NOT_OBSERVED: 'Ultima elaborazione non disponibile',
}[state] || 'Ultima elaborazione non disponibile');
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

export default function OperationalData() {
  const [data, setData] = useState<OperationalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(true);
  const updatePending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('data-sync-complete', refresh);
    return () => window.removeEventListener('data-sync-complete', refresh);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setReadError(false);
    getOperationalStatus(controller.signal).then((response) => {
      if (!response?.success || !response.data?.nightly) throw new Error('Status unavailable');
      if (active) setData(response.data);
    }).catch(() => { if (active) { setData(null); setReadError(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [revision]);

  const updateResults = async () => {
    if (updatePending.current) return;
    updatePending.current = true;
    setUpdating(true); setNotice(null);
    try {
      const response = await refreshMatchResults();
      const result = response?.data;
      if (!response?.success || !result || !['SUCCESS', 'PARTIAL', 'FAILED'].includes(result.status)
        || !validCount(result.updated)) throw new Error('Refresh unavailable');
      if (!mounted.current) return;
      if (result.status === 'SUCCESS') {
        const settled = result.settlement?.settled;
        if (!validCount(settled)) throw new Error('Settlement unavailable');
        setNotice({ error: false, text: `Risultati aggiornati: ${result.updated}. Giocate liquidate: ${settled}.` });
        window.dispatchEvent(new Event('data-sync-complete'));
      } else {
        setNotice({ error: true, text: result.status === 'PARTIAL'
          ? result.settlement === null
            ? 'Aggiornamento completato solo in parte. La liquidazione delle giocate non è stata completata.'
            : 'Aggiornamento completato solo in parte. Alcuni risultati o esiti sono ancora da verificare.'
          : result.settlement === null
            ? 'Non è stato possibile completare l’aggiornamento dei risultati. La liquidazione delle giocate non è disponibile. Riprova.'
            : 'Non è stato possibile completare l’aggiornamento dei risultati. Riprova.' });
        setRevision((value) => value + 1);
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: 'Non è stato possibile completare l’aggiornamento dei risultati. Riprova.' });
    } finally {
      updatePending.current = false;
      if (mounted.current) setUpdating(false);
    }
  };

  return <section className="operational-data">
    <header className="operational-data__head"><div><h1>Dati e aggiornamenti</h1>
      <p>Risultati reali, giocate registrate e ultimo aggiornamento.</p></div>
      <button type="button" className="fp-btn fp-btn-solid" disabled={updating} onClick={() => void updateResults()}>
        {updating ? 'Aggiornamento in corso…' : 'Aggiorna risultati'}
      </button></header>
    <p className="operational-data__help">L’aggiornamento recupera i risultati conclusi e liquida soltanto le giocate virtuali già registrate. Non registra nuove puntate.</p>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'fp-alert fp-alert-warning' : 'fp-alert fp-alert-success'}>{notice.text}</p>}
    {loading && <p role="status">Caricamento degli aggiornamenti…</p>}
    {!loading && readError && <div role="alert" className="fp-alert fp-alert-warning"><p>Non è stato possibile leggere l’ultimo aggiornamento. I dati non sono verificabili in questo momento.</p>
      <button type="button" className="fp-btn fp-btn-ghost" onClick={() => setRevision((value) => value + 1)}>Riprova lettura</button></div>}
    {!loading && !readError && data && <div className="operational-data__grid">
      <section className="operational-data__card" aria-label="Aggiornamento dei dati"><h2>Dati disponibili</h2><dl>
        <div><dt>Ultimo aggiornamento dei dati</dt><dd>{dateTime(data.lastDataUpdateAt)}</dd></div>
        <div><dt>Ultimo aggiornamento dei risultati</dt><dd>{dateTime(data.lastResultsRefreshAt)}</dd></div>
      </dl><p>Un risultato non ancora aggiornato resta in attesa. Le giocate aperte non vengono considerate perse.</p>
      <Link className="fp-btn fp-btn-ghost" to="/predictions?mode=recent">Vedi partite concluse</Link></section>
      <section className="operational-data__card" aria-label="Aggiornamento notturno"><h2>Aggiornamento notturno</h2>
        <p>{nightlyLabel(data.nightly.state)}</p><dl><div><dt>Ultima elaborazione</dt>
          <dd>{dateTime(data.nightly.lastCompletedAt || data.nightly.lastStartedAt)}</dd></div></dl>
        <p>Le giocate effettivamente registrate dai modelli A e C sono raccolte nella pagina Giocate.</p>
        <Link className="fp-btn fp-btn-ghost" to="/bets">Vedi giocate registrate</Link></section>
    </div>}
    <section className="operational-data__sources"><h2>Origine dei dati</h2>
      <p>Understat è la fonte principale per partite, risultati e statistiche. football-data.co.uk integra le statistiche mancanti quando disponibili.</p>
      <p>Le quote mostrate nei consigli riportano il bookmaker che le ha fornite e l’orario di rilevazione. Gli importi nelle giocate sono quelli registrati.</p>
    </section>
  </section>;
}
