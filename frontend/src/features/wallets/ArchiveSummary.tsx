import { WalletArchiveSummary } from '../../utils/walletApi';
import { walletMoney } from './AppWallets';
import '../prediction-archive/prediction-archive.css';
import './wallet-archive.css';

/** Presentation only; all figures are provided by the database-backed archive API. */
export default function ArchiveSummary({ summary, scope }: { summary: WalletArchiveSummary; scope?: string }) {
  return <section className="pa-summary archive-summary" aria-label="Riepilogo giocate">
    <div className="pa-summary__intro"><span>Riepilogo giocate</span><strong>{summary.settled} concluse · {summary.open} aperte</strong>
      <small>{summary.won} vinte · {summary.lost} perse · {summary.void} rimborsate</small>{scope && <small>{scope}</small>}</div>
    <div className="pa-summary__metric pa-summary__metric--win"><span>Vinto</span><strong>{walletMoney(summary.wonCents)}</strong></div>
    <div className="pa-summary__metric pa-summary__metric--loss"><span>Perso</span><strong>{walletMoney(summary.lostCents)}</strong></div>
    <div className={`pa-summary__metric pa-summary__metric--net ${(summary.netCents ?? 0) < 0 ? 'is-negative' : 'is-positive'}`}><span>Saldo netto</span><strong>{walletMoney(summary.netCents)}</strong></div>
    <p>Profitto netto delle giocate liquidate; le giocate aperte sono escluse.{summary.missingProfit ? ' Alcuni risultati economici non sono registrati.' : ''}</p>
  </section>;
}
