import React from 'react';
import { Link } from 'react-router-dom';

interface DashboardProps {
  activeUser: string;
}

const quickActions = [
  {
    title: 'Previsioni',
    description: 'Consulta le partite disponibili e apri il flusso di analisi pre-match.',
    to: '/predictions',
    cta: 'Vai alle previsioni',
  },
  {
    title: 'Budget',
    description: 'Gestisci bankroll, puntate registrate e storico nella sezione dedicata.',
    to: '/budget',
    cta: 'Apri budget',
  },
  {
    title: 'Backtest / Walk-forward',
    description: "Valida l'algoritmo nel tempo con il flusso ufficiale walk-forward.",
    to: '/backtest',
    cta: 'Apri validazione',
  },
  {
    title: 'Dati',
    description: 'Controlla dataset, squadre, partite e strumenti di gestione dati.',
    to: '/data',
    cta: 'Apri dati',
  },
  {
    title: 'Dati & Provider',
    description: 'Gestisci pipeline dati e provider quote dalla pagina operativa.',
    to: '/scrapers',
    cta: 'Apri provider',
  },
];

const DashboardPageView: React.FC<DashboardProps> = () => (
  <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
    <div style={{ marginBottom: 24 }}>
      <h1 className="fp-page-title fp-gradient-blue">Dashboard</h1>
      <p style={{ fontSize: 14, color: 'var(--text-2)', margin: 0, maxWidth: 720, lineHeight: 1.6 }}>
        Accesso rapido alle aree principali
      </p>
    </div>

    <div className="fp-section-block">
      <div className="fp-section-head">
        <div className="fp-section-copy">
          <p className="fp-section-kicker">Navigazione</p>
          <h2 className="fp-section-title">Azioni rapide</h2>
          <p className="fp-section-text">
            Le metriche, i log e i dettagli operativi restano nelle pagine dedicate.
          </p>
        </div>
      </div>
    </div>

    <div className="fp-grid-4">
      {quickActions.map((action) => (
        <Link
          key={action.to}
          to={action.to}
          className="fp-card"
          style={{ color: 'inherit', textDecoration: 'none', display: 'flex', flexDirection: 'column' }}
        >
          <div className="fp-card-head">
            <div className="fp-card-title">{action.title}</div>
          </div>
          <div className="fp-card-body" style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 16 }}>
            <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.6 }}>{action.description}</p>
            <span className="fp-btn fp-btn-ghost fp-btn-sm" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
              {action.cta}
            </span>
          </div>
        </Link>
      ))}
    </div>
  </div>
);

export default DashboardPageView;
