import { useState } from 'react';
import { ComparisonPortfolio } from '../../features/research/researchComparisonTypes';
import { archiveModelOpportunity, placeModelBet } from '../../utils/modelBetActionsApi';
import { getErrorMessage } from '../../utils/errorUtils';
import { BestValueOpportunity } from './predictionTypes';

export default function ModelBetActions({ family, matchId, opportunity, portfolios, onSaved, unavailable, registered = false, quoteCapturedAt }: {
  family: 'A' | 'C'; matchId: string; opportunity: BestValueOpportunity; portfolios: ComparisonPortfolio[];
  onSaved: () => Promise<void>; unavailable?: boolean; registered?: boolean; quoteCapturedAt?: string | null;
}) {
  const wallet = portfolios.find((row) => row.family === family);
  const percent = family === 'C' ? 1 : Number(opportunity.suggestedStakePercent || 0);
  const suggested = typeof wallet?.currentEquityCents === 'number' ? Math.round(wallet.currentEquityCents * percent / 100) : 0;
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [archived, setArchived] = useState(false);
  const classification = [opportunity.marketTier, opportunity.bestBetStatus, opportunity.bestBetDecision?.status].some((value) => String(value).toUpperCase() === 'SPECULATIVE')
    ? 'SPECULATIVE' : String(opportunity.confidence).toUpperCase() === 'LOW' ? 'LOW' : null;
  const stakeCents = amount ? Math.round(Number(amount) * 100) : suggested;
  const realPrice = Number(opportunity.bookmakerOdds) > 1 && !!opportunity.bookmakerName;
  const enabled = !unavailable && realPrice && !registered && !saved && wallet?.initialized !== false;
  const quoteTime = quoteCapturedAt ? Date.parse(quoteCapturedAt) : null;
  const staleQuote = quoteTime !== null && (!Number.isFinite(quoteTime) || quoteTime > Date.now() || Date.now() - quoteTime > 300_000);
  const run = async (kind: 'bet' | 'archive') => {
    setBusy(true); setMessage('');
    try {
      if (kind === 'bet') {
        await placeModelBet({ family, matchId, selection: opportunity.selection, stakeCents,
          bookmakerOdds: Number(opportunity.bookmakerOdds), bookmakerName: opportunity.bookmakerName! });
        setSaved(true); setMessage(`Giocata virtuale registrata nel portafoglio ${family}.`);
      } else if (classification) {
        await archiveModelOpportunity({ family, matchId, selection: opportunity.selection, classification,
          marketName: opportunity.marketName, bookmakerOdds: Number(opportunity.bookmakerOdds),
          bookmakerName: opportunity.bookmakerName!, suggestedStakePercent: percent });
        setArchived(true); setMessage(`Opportunità ${family} archiviata senza impegnare capitale.`);
        window.dispatchEvent(new Event('model-opportunity-archived'));
      }
      try { await onSaved(); }
      catch { setMessage(kind === 'bet'
        ? `Giocata virtuale registrata nel portafoglio ${family}. Il saldo non è ancora aggiornato: consulta Budget.`
        : `Opportunità ${family} archiviata. Ricarica l’archivio per visualizzarla.`); }
    } catch (error) { setMessage(getErrorMessage(error, 'Operazione non riuscita.')); }
    finally { setBusy(false); }
  };
  return <div className="model-bet-actions" aria-label={`Azioni giocata ${family}`}>
    {classification && <p>Rischio {classification === 'LOW' ? 'bassa confidenza' : 'speculativo'}: puoi conservare la selezione in archivio senza puntare.</p>}
    <label>Importo virtuale · portafoglio {family}<input aria-label={`Importo modello ${family}`} type="number" min="0.01" step="0.01" value={amount}
      placeholder={(suggested / 100).toFixed(2)} onChange={(event) => setAmount(event.target.value)} disabled={busy || !enabled} /></label>
    <div className="model-bet-actions__buttons"><button type="button" className="fp-btn fp-btn-solid" disabled={busy || !enabled || staleQuote || !wallet || !Number.isSafeInteger(stakeCents) || stakeCents <= 0}
      onClick={() => void run('bet')}>{registered || saved ? 'Giocata già registrata' : `Scommetti con ${family}`}</button>
      {classification && <button type="button" className="fp-btn fp-btn-ghost" disabled={busy || !realPrice || !!unavailable || archived} onClick={() => void run('archive')}>{archived ? 'Archiviata' : 'Archivia senza puntare'}</button>}</div>
    {unavailable && <p>Registrazione non disponibile: servono una partita futura e una quota reale valida.</p>}
    {staleQuote && !registered && !saved && <p>Quota salvata non più valida per puntare. Nessuna nuova quota viene richiesta automaticamente.</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
