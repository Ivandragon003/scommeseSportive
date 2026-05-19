import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardPageView from './DashboardPageView';

const renderDashboard = () => render(
  <MemoryRouter>
    <DashboardPageView activeUser="user1" />
  </MemoryRouter>
);

describe('DashboardPageView', () => {
  test('mostra solo titolo, sottotitolo e azioni rapide', () => {
    renderDashboard();
    const links = screen.getAllByRole('link');

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByText('Accesso rapido alle aree principali')).toBeTruthy();
    expect(screen.getByText('Azioni rapide')).toBeTruthy();
    expect(links.find((link) => link.textContent?.includes('Previsioni'))?.getAttribute('href')).toBe('/predictions');
    expect(links.find((link) => link.textContent?.includes('Budget'))?.getAttribute('href')).toBe('/budget');
    expect(links.find((link) => link.textContent?.includes('Backtest / Walk-forward'))?.getAttribute('href')).toBe('/backtest');
    expect(links.find((link) => link.textContent?.includes('Apri dati'))?.getAttribute('href')).toBe('/data');
    expect(links.find((link) => link.textContent?.includes('Dati & Provider'))?.getAttribute('href')).toBe('/scrapers');
  });

  test('non mostra sezioni tecniche, metriche, log, bankroll o quote', () => {
    renderDashboard();

    [
      'Ricarica dashboard',
      'Salute operativa',
      'Provider Quote',
      'Freshness Quote',
      'Fallback Rate',
      'Latency Scraping',
      'Provider e Freshness',
      'Trend Errori e Warning',
      'Run recenti sistema',
      'Run Recenti Sistema',
      'provider_fetch',
      'eurobet_provider',
      'warning run',
      'error run',
      'success rate',
      'fixture match rate',
      'timeout',
      'Controllo budget',
      'Budget Disponibile',
      'ROI Reale',
      'Win Rate',
      'Scommesse Totali',
      'Riepilogo Finanziario',
      'Riepilogo finanziario',
      'Budget Totale',
      'Totale Puntato',
      'Totale Vinto',
      'Totale Perso',
      'Profitto Netto',
      'CLV Positivo',
      'Qualita Dataset',
      'Qualità dataset',
      'xG',
      'Tiri',
      'Tiri in porta',
      'Falli',
      'Gialli',
      'Archivio Quote',
      'Archivio quote',
      'Snapshot totali',
      'Match coperti',
      'Con quote reali',
      'Con completamento modello',
      'Solo bookmaker preferito',
      'Fonti principali',
      'Pipeline Notturna',
      'Pipeline notturna',
      'Import dati Understat',
      'Snapshot quote',
      'Learning review',
      'Storico Ultimi 7 Run',
      'Storico ultimi 7 run',
      'Orario',
      'Ultimo run',
      'Durata',
      'Nuove partite',
      'Aggiornate',
      'Prossimo run',
      'Review create',
      'Review refresh',
      'Closing Line Tracking',
      'Bet tracciate',
      'Con closing line',
      'CLV medio',
      'Ultime Scommesse',
      'Ultime scommesse',
      'Mercato',
      'Selezione',
      'Quota',
      'Puntata',
      'P. Nostra',
      'EV',
      'Stato',
      'Profitto',
    ].forEach((label) => {
      expect(screen.queryByText(label)).toBeNull();
    });
  });
});
