import React, { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, HelpCircle, Lock, RotateCcw, TrendingUp, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ToastStack from '../components/common/ToastStack';
import BankrollTrendChart from '../components/budget/BankrollTrendChart';
import { useBudgetManagerData } from '../hooks/useBudgetManagerData';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useToastState } from '../hooks/useToastState';
import { initBudget } from '../utils/api';
import { getErrorMessage } from '../utils/errorUtils';
import './budget-manager.css';

interface BudgetManagerProps {
  activeUser: string;
}

const toAmount = (value: unknown) => Number(value ?? 0);
const formatMoney = (value: unknown) => `EUR ${Number(value ?? 0).toFixed(2)}`;

const BudgetManager: React.FC<BudgetManagerProps> = ({ activeUser }) => {
  const [initAmount, setInitAmount] = useState('1000');
  const [showReset, setShowReset] = useState(false);
  const toastState = useToastState();
  const confirmDialog = useConfirmDialog();
  const {
    budget,
    loading,
    pendingBets,
    settledBets,
    netProfit,
    winsCount,
    lossesCount,
    voidCount,
    loadAll,
  } = useBudgetManagerData(activeUser);

  const initializeBudget = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toastState.showToast({ tone: 'warning', message: 'Inserisci un importo valido.' });
      return;
    }

    try {
      await initBudget(activeUser, amount);
      await loadAll({ force: true });
      setShowReset(false);
    } catch (error: unknown) {
      toastState.showToast({ tone: 'error', message: getErrorMessage(error, 'Errore durante il salvataggio del budget') });
    }
  };

  const startNewSession = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toastState.showToast({ tone: 'warning', message: 'Inserisci un importo valido per il nuovo bankroll.' });
      return;
    }

    const confirmed = await confirmDialog.confirm({
      title: 'Avviare una nuova sessione?',
      message: `Le giocate già registrate resteranno archiviate. Confermi il nuovo bankroll per ${activeUser}?`,
      confirmLabel: 'Avvia nuova sessione',
      tone: 'danger',
    });
    if (confirmed) await initializeBudget();
  };

  const totalBudget = toAmount(budget?.total_budget);
  const availableBudget = toAmount(budget?.available_budget);
  const capitalExposure = pendingBets.reduce((sum, bet) => sum + toAmount(bet?.stake), 0);
  const settledCount = winsCount + lossesCount + voidCount;
  const roi = toAmount(budget?.roi);
  const usedPct = budget
    ? Math.min(100, Math.max(0, ((totalBudget - availableBudget) / Math.max(1, totalBudget)) * 100))
    : 0;
  const roiReading = settledCount === 0
    ? 'Campione ancora ridotto'
    : roi > 0
      ? `ROI positivo, da leggere insieme a ${settledCount} giocate concluse.`
      : roi < 0
        ? `ROI negativo su ${settledCount} giocate concluse.`
        : `ROI neutro su ${settledCount} giocate concluse.`;

  useEffect(() => {
    if (budget?.total_budget !== undefined && budget?.total_budget !== null) {
      setInitAmount(String(Number(budget.total_budget)));
    }
  }, [budget?.total_budget]);

  return (
    <>
      <main className="bm-wrap budget-page">
        <header className="bm-head">
          <div>
            <h1 className="bm-title">Budget</h1>
            <p className="bm-sub">Gestisci il tuo bankroll e monitora i risultati nel tempo.</p>
          </div>
          <button type="button" className="account-page-help" aria-label="Apri aiuto pagina" onClick={() => window.dispatchEvent(new CustomEvent('glossary-open'))}><HelpCircle size={24} /></button>
        </header>

        {loading ? (
          <div className="bm-skeleton" aria-busy="true" aria-label="Caricamento budget"><span /><span /><span /></div>
        ) : !budget ? (
          <section className="budget-init" aria-labelledby="budget-init-title">
            <div className="budget-init__icon"><WalletCards size={28} aria-hidden="true" /></div>
            <div>
              <span className="fp-section-kicker">Primo passo</span>
              <h2 id="budget-init-title">Crea il bankroll iniziale</h2>
              <p>Definisci la somma di partenza. Potrai poi controllare disponibilità, esposizione e risultati.</p>
            </div>
            <div className="bm-init-row">
              <label htmlFor="budget-initial-amount">Bankroll iniziale</label>
              <div className="budget-amount-input"><span>EUR</span><input id="budget-initial-amount" type="number" min="0.01" value={initAmount} onChange={(event) => setInitAmount(event.target.value)} placeholder="1000" /></div>
              <button className="fp-btn fp-btn-solid" type="button" onClick={initializeBudget}>Inizializza</button>
            </div>
          </section>
        ) : (
          <>
            <dl className="bm-summary" aria-label="Riepilogo bankroll">
              <div className="bm-summary__item is-positive" data-testid="budget-available">
                <span className="bm-summary__icon"><WalletCards size={25} aria-hidden="true" /></span>
                <span><dt>Bankroll disponibile</dt><dd>{formatMoney(availableBudget)}</dd><small>Aggiornato con le giocate registrate</small></span>
              </div>
              <div className="bm-summary__item" data-testid="budget-exposure">
                <span className="bm-summary__icon"><Lock size={25} aria-hidden="true" /></span>
                <span><dt>Capitale impegnato</dt><dd>{formatMoney(capitalExposure)}</dd><small>{pendingBets.length} giocate aperte</small></span>
              </div>
              <div className={`bm-summary__item ${netProfit >= 0 ? 'is-positive' : 'is-negative'}`} data-testid="budget-profit">
                <span className="bm-summary__icon"><TrendingUp size={25} aria-hidden="true" /></span>
                <span><dt>Risultato netto</dt><dd>{netProfit >= 0 ? '+' : ''}{formatMoney(netProfit)}</dd><strong data-testid="budget-roi">{roi >= 0 ? '+' : ''}{roi.toFixed(2)}%</strong><small>{roiReading}</small></span>
              </div>
            </dl>

            <div className="budget-workspace">
              <BankrollTrendChart initialBudget={totalBudget} settledBets={settledBets} />

              <section className="budget-management" aria-labelledby="budget-management-title">
                <h2 id="budget-management-title">Gestione bankroll</h2>
                <div className="budget-current"><span>Bankroll attuale</span><strong>{formatMoney(availableBudget)}</strong></div>
                <form onSubmit={(event) => { event.preventDefault(); void startNewSession(); }}>
                  <label htmlFor="budget-initial-input">Budget iniziale</label>
                  <div className="budget-amount-input"><span>EUR</span><input id="budget-initial-input" aria-label="Budget iniziale" type="number" min="0.01" value={initAmount} onChange={(event) => setInitAmount(event.target.value)} /></div>
                  <button className="fp-btn fp-btn-green" type="submit">Aggiorna budget</button>
                </form>
                <Link className="budget-open-bets-link" to="/bets">Vai alle giocate aperte <ArrowRight size={18} aria-hidden="true" /></Link>
              </section>
            </div>

            <div className="budget-accessible-facts sr-only">
              <span data-testid="budget-initial">Bankroll iniziale {formatMoney(totalBudget)}</span>
              <div role="progressbar" aria-label="Budget utilizzato" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(usedPct.toFixed(1))}>{usedPct.toFixed(1)}%</div>
            </div>

            <section className={`bm-maintenance${showReset ? ' is-open' : ''}`} aria-labelledby="budget-maintenance-title">
              <span className="bm-maintenance__icon"><RotateCcw size={24} aria-hidden="true" /></span>
              <div className="bm-maintenance__copy"><h2 id="budget-maintenance-title">Manutenzione budget</h2><p>Avvia una nuova sessione senza cancellare le giocate già archiviate.</p></div>
              <button className="bm-maintenance__toggle" type="button" aria-expanded={showReset} onClick={() => setShowReset((value) => !value)}><span>{showReset ? 'Chiudi' : 'Gestisci'}</span><ChevronDown size={20} aria-hidden="true" /></button>
              {showReset && (
                <div className="bm-maintenance__form">
                  <label htmlFor="budget-reset-amount">Nuovo bankroll</label>
                  <div className="budget-amount-input"><span>EUR</span><input id="budget-reset-amount" type="number" min="0.01" value={initAmount} onChange={(event) => setInitAmount(event.target.value)} /></div>
                  <button className="fp-btn fp-btn-red" type="button" onClick={startNewSession}>Avvia nuova sessione</button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <ToastStack toasts={toastState.toasts} onDismiss={toastState.dismissToast} />
      <ConfirmDialog {...confirmDialog.dialogProps} />
    </>
  );
};

export default BudgetManager;
