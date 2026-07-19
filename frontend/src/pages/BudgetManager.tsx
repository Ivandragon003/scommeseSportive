import React, { useState } from 'react';
import { initBudget } from '../utils/api';
import ToastStack from '../components/common/ToastStack';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useToastState } from '../hooks/useToastState';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useBudgetManagerData } from '../hooks/useBudgetManagerData';
import { getErrorMessage } from '../utils/errorUtils';
import GlossaryTerm from '../features/glossary/GlossaryTerm';
import './budget-manager.css';

interface BudgetManagerProps {
  activeUser: string;
}

const toAmount = (v: any) => Number(v ?? 0);
const formatDateTime = (value: any) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('it-IT');
};
const formatBudgetMarketName = (value: any) => {
  const label = String(value ?? '').trim();
  if (!label) return 'Mercato non disponibile';
  return label
    .replace(/Draw No Bet/gi, 'Pareggio non conta (DNB)')
    .replace(/Goal\/Goal - Si/gi, 'Entrambe segnano - Sì')
    .replace(/Goal\/Goal - No/gi, 'Entrambe segnano - No');
};
const getBudgetSelectionLabel = (value: any) => {
  const label = String(value ?? '').trim();
  if (!label) return null;

  const isInternalCode = /^(?:dnb_|player_|homeWin$|awayWin$|draw$|btts(?:No)?$|(?:under|over|yellow|shots|cards)[A-Z0-9_])/i.test(label);
  return isInternalCode ? null : label;
};

const BudgetManager: React.FC<BudgetManagerProps> = ({ activeUser }) => {
  const [initAmount, setInitAmount] = useState('1000');
  const [showReset, setShowReset] = useState(false);
  const toastState = useToastState();
  const confirmDialog = useConfirmDialog();
  const {
    budget,
    bets,
    filter,
    loading,
    pendingBets,
    netProfit,
    winsCount,
    lossesCount,
    voidCount,
    setFilter,
    loadAll,
  } = useBudgetManagerData(activeUser);

  const handleReset = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
      await initBudget(activeUser, amount);
      await loadAll({ force: true });
      setShowReset(false);
    } catch (e: any) {
      toastState.showToast({ tone: 'error', message: getErrorMessage(e, 'Errore reset budget') });
    }
  };

  const handleQuickReset = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toastState.showToast({ tone: 'warning', message: 'Inserisci un importo valido per il reset.' });
      return;
    }
    const confirmed = await confirmDialog.confirm({
      title: 'Confermare reset completo?',
      message: `Confermi il reset completo di budget e scommesse per l'utente ${activeUser}?`,
      confirmLabel: 'Reset completo',
      tone: 'danger',
    });
    if (!confirmed) return;
    await handleReset();
  };

  const usedPct = budget
    ? Math.min(100, ((toAmount(budget.total_budget) - toAmount(budget.available_budget)) / Math.max(1, toAmount(budget.total_budget))) * 100)
    : 0;
  const capitalExposure = pendingBets.reduce((sum, bet) => sum + toAmount(bet?.stake), 0);
  const settledCount = winsCount + lossesCount + voidCount;
  const roi = Number(budget?.roi ?? 0);
  const roiReading =
    settledCount === 0
      ? 'Campione insufficiente: il ROI diventa interpretabile dopo le prime scommesse concluse.'
      : roi > 0
        ? `ROI positivo, da leggere insieme a ${settledCount} scommesse concluse.`
        : roi < 0
          ? `ROI negativo su ${settledCount} scommesse concluse: non descrive da solo la qualità futura della strategia.`
          : `ROI neutro su ${settledCount} scommesse concluse.`;

  const statusLabel = (s: string) => {
    if (s === 'WON') return 'VINTA';
    if (s === 'LOST') return 'PERSA';
    if (s === 'VOID') return 'ANNULLATA';
    return 'ATTESA';
  };

  const statusClass = (s: string) => {
    if (s === 'WON') return 'won';
    if (s === 'LOST') return 'lost';
    if (s === 'VOID') return 'void';
    return 'pending';
  };

  return (
    <>
      <div className="bm-wrap">
        <div className="bm-head">
          <div>
            <h1 className="bm-title">Budget e giocate</h1>
            <div className="bm-sub">Esito automatico su partite concluse e storico completo</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!loading && budget && (
              <button
                className="fp-btn fp-btn-ghost fp-btn-sm"
                onClick={() => setShowReset((value) => !value)}
                title="Apri manutenzione bankroll e reset scommesse"
              >
                Manutenzione bankroll
              </button>
            )}
            <div className="bm-user">Utente: <strong>{activeUser}</strong></div>
          </div>
        </div>

        {loading ? (
          <div className="fp-spinner-wrap" style={{ minHeight: 280 }}><div className="fp-spinner" /></div>
        ) : !budget ? (
          <div className="fp-card bm-init">
            <div className="fp-card-head"><div className="fp-card-title">Crea bankroll iniziale</div></div>
            <div className="fp-card-body">
              <div className="bm-init-row" style={{ marginBottom: 12 }}>
                <label className="sr-only" htmlFor="budget-initial-amount">Bankroll iniziale in euro</label>
                <input
                  id="budget-initial-amount"
                  className="fp-input"
                  type="number"
                  value={initAmount}
                  onChange={(e) => setInitAmount(e.target.value)}
                  placeholder="1000"
                />
                <button className="fp-btn fp-btn-solid" onClick={handleReset}>Inizializza</button>
              </div>
              <div className="fp-alert fp-alert-info">
                Imposta il budget iniziale per iniziare a registrare le scommesse.
              </div>
            </div>
          </div>
        ) : (
          <>
            <dl className="bm-summary" aria-label="Riepilogo bankroll">
              <div className="bm-summary__item" data-testid="budget-initial">
                <dt>Bankroll iniziale</dt>
                <dd>EUR {toAmount(budget.total_budget).toFixed(2)}</dd>
              </div>
              <div className="bm-summary__item is-positive" data-testid="budget-available">
                <dt>Bankroll disponibile</dt>
                <dd>EUR {toAmount(budget.available_budget).toFixed(2)}</dd>
              </div>
              <div className="bm-summary__item" data-testid="budget-exposure">
                <dt><GlossaryTerm termId="exposure">Capitale esposto</GlossaryTerm></dt>
                <dd>EUR {capitalExposure.toFixed(2)}</dd>
              </div>
              <div className={`bm-summary__item ${netProfit >= 0 ? 'is-positive' : 'is-negative'}`} data-testid="budget-profit">
                <dt>Profitto netto</dt>
                <dd>{netProfit >= 0 ? '+' : ''}EUR {netProfit.toFixed(2)}</dd>
              </div>
              <div className={`bm-summary__item ${roi >= 0 ? 'is-positive' : 'is-negative'}`} data-testid="budget-roi">
                <dt><GlossaryTerm termId="roi">Rendimento (ROI)</GlossaryTerm></dt>
                <dd>{roi.toFixed(2)}%</dd>
              </div>
              <div className="bm-summary__item">
                <dt><GlossaryTerm termId="pending-bet">Scommesse pendenti</GlossaryTerm></dt>
                <dd>{pendingBets.length}</dd>
              </div>
            </dl>

            <div className={`fp-alert ${roi < 0 ? 'fp-alert-warning' : 'fp-alert-info'} bm-roi-reading`}>
              {roiReading}
            </div>

            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Dettaglio finanziario</div>
                  <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => setShowReset((v) => !v)}>Apri manutenzione</button>
                </div>
                <div className="fp-card-body">
                  <div className="bm-fin-grid">
                    <div className="bm-fin-row"><span className="bm-fin-k">Bankroll iniziale</span><strong className="bm-fin-v">EUR {toAmount(budget.total_budget).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Bankroll disponibile</span><strong className="bm-fin-v" style={{ color: 'var(--green)' }}>EUR {toAmount(budget.available_budget).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Capitale esposto nelle pendenti</span><strong className="bm-fin-v">EUR {capitalExposure.toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale puntato storico</span><strong className="bm-fin-v">EUR {toAmount(budget.total_staked).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale ritorni vincenti</span><strong className="bm-fin-v">EUR {toAmount(budget.total_won).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale perso</span><strong className="bm-fin-v">EUR {toAmount(budget.total_lost).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Rendimento (ROI)</span><strong className="bm-fin-v" style={{ color: roi >= 0 ? 'var(--green)' : 'var(--red)' }}>{roi.toFixed(2)}%</strong></div>
                  </div>
                </div>
              </div>

              <div className="fp-card">
                <div className="fp-card-head"><div className="fp-card-title">Performance</div></div>
                <div className="fp-card-body">
                  <div className="fp-progress-wrap">
                    <div className="fp-progress-meta"><span>Budget utilizzato</span><span className="fp-progress-val">{usedPct.toFixed(1)}%</span></div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${usedPct}%` }} /></div>
                  </div>
                  <div className="fp-progress-wrap">
                    <div className="fp-progress-meta">
                      <span><GlossaryTerm termId="win-rate">Percentuale di vittorie</GlossaryTerm></span>
                      <span className="fp-progress-val">{Number(budget.win_rate ?? 0).toFixed(1)}%</span>
                    </div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${Math.min(100, Number(budget.win_rate ?? 0))}%`, background: 'var(--green)' }} /></div>
                  </div>
                  <div className="fp-progress-wrap" style={{ marginBottom: 14 }}>
                    <div className="fp-progress-meta">
                      <span><GlossaryTerm termId="roi">ROI</GlossaryTerm></span>
                      <span className="fp-progress-val">{Number(budget.roi ?? 0).toFixed(1)}%</span>
                    </div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${Math.min(100, Math.max(0, Number(budget.roi ?? 0)))}%`, background: Number(budget.roi ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span className="fp-badge fp-badge-green">Vinte: {winsCount}</span>
                    <span className="fp-badge fp-badge-red">Perse: {lossesCount}</span>
                    <span className="fp-badge fp-badge-gold">Annullate: {voidCount}</span>
                    <span className="fp-badge fp-badge-blue">Pendenti: {pendingBets.length}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="fp-card" style={{ marginBottom: 18 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Scommesse in attesa ({pendingBets.length})</div>
              </div>
              <div className="fp-card-body" style={{ paddingTop: 10 }}>
                <div className="fp-alert fp-alert-info" style={{ marginBottom: 10 }}>
                  Le scommesse vengono chiuse automaticamente quando la partita e conclusa e i dati necessari sono presenti.
                </div>
                {pendingBets.length === 0 ? (
                  <div className="fp-empty"><div className="fp-empty-text">Nessuna scommessa pendente.</div></div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="fp-table">
                      <thead>
                        <tr>
                          <th>Partita</th>
                          <th>Mercato</th>
                          <th>Quota</th>
                          <th>Puntata</th>
                          <th>Data</th>
                          <th>Stato</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingBets.map((bet: any) => (
                          <tr key={String(bet.bet_id)}>
                            <td>
                              <div className="bm-match">{bet.home_team_name ?? '-' } vs {bet.away_team_name ?? '-'}</div>
                              <div className="bm-market">{bet.competition ?? '-'}</div>
                            </td>
                            <td>
                              <div className="bm-match">{formatBudgetMarketName(bet.market_name)}</div>
                              {getBudgetSelectionLabel(bet.selection) && (
                                <div className="bm-market">{getBudgetSelectionLabel(bet.selection)}</div>
                              )}
                            </td>
                            <td className="fp-mono">{Number(bet.odds ?? 0).toFixed(2)}</td>
                            <td className="fp-mono">EUR {Number(bet.stake ?? 0).toFixed(2)}</td>
                            <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatDateTime(bet.placed_at)}</td>
                            <td><span className={`bm-status ${statusClass(String(bet.status ?? 'PENDING'))}`}>{statusLabel(String(bet.status ?? 'PENDING'))}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">Storico scommesse</div>
                <div className="bm-ftabs" role="group" aria-label="Filtra storico giocate">
                  {[
                    { value: '', label: 'Tutte' },
                    { value: 'PENDING', label: 'Attesa' },
                    { value: 'WON', label: 'Vinte' },
                    { value: 'LOST', label: 'Perse' },
                    { value: 'VOID', label: 'Annullate' },
                  ].map((f) => (
                    <button
                      key={f.value || 'all'}
                      className={`bm-ftab${filter === f.value ? ' active' : ''}`}
                      onClick={() => setFilter(f.value)}
                      aria-pressed={filter === f.value}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {bets.length === 0 ? (
                <div className="fp-empty"><div className="fp-empty-text">Nessuna scommessa registrata.</div></div>
              ) : (
                <div className="bm-history-table">
                  <table className="fp-table">
                    <thead>
                      <tr>
                        <th>Partita</th>
                        <th>Mercato</th>
                        <th>Quota</th>
                        <th>Puntata</th>
                        <th>Stato</th>
                        <th>Profitto</th>
                        <th>Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bets.slice(0, 80).map((bet: any) => (
                        <tr key={String(bet.bet_id)}>
                          <td>
                            <div className="bm-match">{bet.home_team_name ?? '-'} vs {bet.away_team_name ?? '-'}</div>
                            <div className="bm-market">{bet.competition ?? '-'}</div>
                          </td>
                          <td>
                            <div className="bm-match">{formatBudgetMarketName(bet.market_name)}</div>
                            {getBudgetSelectionLabel(bet.selection) && (
                              <div className="bm-market">{getBudgetSelectionLabel(bet.selection)}</div>
                            )}
                          </td>
                          <td className="fp-mono">{Number(bet.odds ?? 0).toFixed(2)}</td>
                          <td className="fp-mono">EUR {Number(bet.stake ?? 0).toFixed(2)}</td>
                          <td><span className={`bm-status ${statusClass(String(bet.status ?? 'PENDING'))}`}>{statusLabel(String(bet.status ?? 'PENDING'))}</span></td>
                          <td className="fp-mono" style={{ color: Number(bet.profit ?? 0) > 0 ? 'var(--green)' : Number(bet.profit ?? 0) < 0 ? 'var(--red)' : 'var(--text-2)' }}>
                            {bet.profit !== null && bet.profit !== undefined ? `${Number(bet.profit) > 0 ? '+' : ''}EUR ${Number(bet.profit).toFixed(2)}` : '-'}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatDateTime(bet.placed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {showReset && (
              <section className="bm-maintenance" aria-labelledby="budget-maintenance-title">
                <h2 id="budget-maintenance-title">Manutenzione del bankroll</h2>
                <p>
                  Operazione distruttiva: reimposta il bankroll e cancella tutte le scommesse
                  associate all’utente selezionato.
                </p>
                <div className="bm-init-row">
                  <label className="fp-label" htmlFor="budget-reset-amount">Nuovo bankroll iniziale</label>
                  <input
                    id="budget-reset-amount"
                    className="fp-input"
                    type="number"
                    min="0.01"
                    value={initAmount}
                    onChange={(event) => setInitAmount(event.target.value)}
                  />
                  <button className="fp-btn fp-btn-red" onClick={handleQuickReset}>
                    Reimposta e cancella lo storico
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
      <ToastStack toasts={toastState.toasts} onDismiss={toastState.dismissToast} />
      <ConfirmDialog {...confirmDialog.dialogProps} />
    </>
  );
};

export default BudgetManager;
