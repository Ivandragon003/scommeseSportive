import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlossaryPage from './GlossaryPage';
import { GlossaryProvider } from './GlossaryProvider';
import GlossaryTerm from './GlossaryTerm';
import { GLOSSARY_ENTRIES } from './glossaryEntries';

const REQUIRED_TERM_IDS = [
  'decimal-odds',
  'implied-probability',
  'model-probability',
  'vig',
  'overround',
  'no-vig-odds',
  'value-bet',
  'expected-value',
  'edge',
  'bankroll',
  'stake',
  'exposure',
  'kelly-criterion',
  'fractional-kelly',
  'roi',
  'win-rate',
  'pending-bet',
  'void',
  'confidence',
  'european-handicap',
  'asian-handicap',
  'lambda',
  'poisson-distribution',
  'dixon-coles',
  'negative-binomial',
  'variance',
  'dispersion',
  'calibration',
  'backtesting',
  'walk-forward',
  'training-window',
  'test-window',
  'expanding-window',
  'fold',
  'baseline',
  'overfitting',
  'clv',
  'closing-odds',
  'historical-snapshot',
  'synthetic-odds',
  'data-quality',
  'statistical-sample',
] as const;

describe('glossario', () => {
  test('copre tutti i termini obbligatori con contenuti utili all interpretazione', () => {
    const byId = new Map(GLOSSARY_ENTRIES.map((entry) => [entry.id, entry]));

    REQUIRED_TERM_IDS.forEach((id) => {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(entry?.term.length).toBeGreaterThan(1);
      expect(entry?.category.length).toBeGreaterThan(2);
      expect(entry?.simpleDefinition.length).toBeGreaterThan(20);
      expect(entry?.technicalDefinition.length).toBeGreaterThan(30);
      expect(entry?.example.length).toBeGreaterThan(15);
      expect(entry?.highValue.length).toBeGreaterThan(10);
      expect(entry?.lowValue.length).toBeGreaterThan(10);
      expect(entry?.positiveMeaning.length).toBeGreaterThan(10);
      expect(entry?.negativeMeaning.length).toBeGreaterThan(10);
      expect(entry?.interpretation.length).toBeGreaterThan(15);
      expect(entry?.caution.length).toBeGreaterThan(15);
      expect(Array.isArray(entry?.relatedTerms)).toBe(true);
    });

    expect(byId.get('roi')?.formula).toMatch(/profitto/i);
    expect(byId.get('expected-value')?.formula).toMatch(/probabil/i);
    expect(byId.get('implied-probability')?.formula).toContain('1');
    expect(byId.has('referee')).toBe(false);
    expect(byId.has('corners')).toBe(false);
    expect(byId.has('yellow-cards')).toBe(false);
    expect(byId.has('red-cards')).toBe(false);
    expect(byId.has('double-chance')).toBe(false);
    expect(byId.has('btts')).toBe(false);
    expect(byId.has('eurobet')).toBe(false);
    expect(byId.has('xg')).toBe(false);
    expect(byId.has('fouls')).toBe(false);
    expect(byId.has('odds-source')).toBe(false);
    expect(byId.has('football-data')).toBe(false);
    expect(byId.has('goal-no-goal')).toBe(false);
    expect(byId.has('expected-goals')).toBe(false);
    expect(byId.has('reliability-level')).toBe(false);
    expect(byId.has('bookmaker-margin')).toBe(false);
    expect(byId.has('player-props')).toBe(false);
    expect(byId.has('one-x-two')).toBe(false);
    expect(byId.has('over-under')).toBe(false);
    expect(byId.has('draw-no-bet')).toBe(false);
    expect(byId.has('net-profit')).toBe(false);
    expect(byId.has('exact-score')).toBe(false);
    expect(byId.has('shots')).toBe(false);
    expect(byId.has('shots-on-target')).toBe(false);
    expect(byId.has('team-total')).toBe(false);
    expect(byId.has('understat')).toBe(false);
  });

  test('pagina dedicata filtra per testo e mostra categorie e indice alfabetico', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlossaryProvider>
          <GlossaryPage />
        </GlossaryProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Glossario' })).toBeTruthy();
    expect(screen.getByLabelText(/Categorie del glossario/i)).toBeTruthy();
    expect(screen.getByLabelText(/Indice alfabetico/i)).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: /Cerca nel glossario/i }), {
      target: { value: 'ROI' },
    });

    expect(screen.getByRole('heading', { name: /Rendimento sull.*investimento/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Distribuzione di Poisson/i })).toBeNull();
  });

  test('termine contestuale apre il drawer rapido con definizione e link completo', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlossaryProvider>
          <p>
            Il <GlossaryTerm termId="roi">ROI</GlossaryTerm> aiuta a leggere il rendimento.
          </p>
        </GlossaryProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: /Spiega ROI/i }));

    const dialog = screen.getByRole('dialog', { name: /Glossario rapido/i });
    expect(dialog.textContent).toContain('Rendimento sull’investimento');
    expect(screen.getByRole('link', { name: /Apri definizione completa/i })).toBeTruthy();
  });
});
