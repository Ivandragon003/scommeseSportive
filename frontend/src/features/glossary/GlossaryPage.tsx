import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { GLOSSARY_ENTRIES } from './glossaryEntries';
import type { GlossaryEntry } from './glossaryTypes';

const CATEGORY_GROUPS = {
  Tutti: null,
  Pronostici: ['Mercati di scommessa', 'Value betting'],
  Quote: ['Quote e probabilità'],
  Budget: ['Gestione del bankroll', 'Rischio e stake'],
  Statistiche: ['Modelli statistici', 'Statistiche calcistiche', 'Backtesting e validazione', 'Fonti e qualità dei dati'],
} as const;

type CategoryGroup = keyof typeof CATEGORY_GROUPS;

const EntryDetails: React.FC<{ entry: GlossaryEntry; showHeading?: boolean }> = ({ entry, showHeading = true }) => (
  <div className="glossary-entry__body">
    <span className="glossary-category-label">{entry.category}</span>
    {showHeading && <h2>{entry.term}{entry.acronym && !entry.term.toLocaleLowerCase('it').includes(entry.acronym.toLocaleLowerCase('it')) ? ` (${entry.acronym})` : ''}</h2>}
    <p className="glossary-lead">{entry.simpleDefinition}</p>
    <p>{entry.technicalDefinition}</p>
    {entry.formula && (
      <details className="glossary-formula">
        <summary>Calcolo facoltativo</summary>
        <div>
          <code>{entry.formula}</code>
          <small>Non serve ricordarlo per usare l’app.</small>
        </div>
      </details>
    )}
    <div className="glossary-example"><strong>Esempio pratico</strong><p>{entry.example}</p></div>
    <dl className="glossary-detail-grid">
      <div><dt>Cosa significa per te</dt><dd>{entry.interpretation}</dd></div>
      <div><dt>Attenzione</dt><dd>{entry.caution}</dd></div>
    </dl>
    {entry.relatedTerms.length > 0 && (
      <div className="glossary-related">
        <span>Termini correlati</span>
        <div>{entry.relatedTerms.map((id) => GLOSSARY_ENTRIES.find((candidate) => candidate.id === id)).filter(Boolean).map((related) => <a key={related?.id} href={`#${related?.id}`}>{related?.term}</a>)}</div>
      </div>
    )}
  </div>
);

const GlossaryPage: React.FC = () => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryGroup>('Tutti');
  const [selectedId, setSelectedId] = useState(GLOSSARY_ENTRIES[0]?.id ?? '');

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('it');
    const allowedCategories = CATEGORY_GROUPS[category];
    return GLOSSARY_ENTRIES.filter((entry) => {
      if (allowedCategories && !(allowedCategories as readonly string[]).includes(entry.category)) return false;
      if (!normalizedQuery) return true;
      return [entry.term, entry.acronym, ...(entry.aliases ?? []), entry.simpleDefinition, entry.category]
        .filter(Boolean).join(' ').toLocaleLowerCase('it').includes(normalizedQuery);
    });
  }, [category, query]);

  const letters = useMemo(() => Array.from(new Set(GLOSSARY_ENTRIES.map((entry) => entry.term[0].toLocaleUpperCase('it')))).sort(), []);
  const selectedEntry = filteredEntries.find((entry) => entry.id === selectedId) ?? filteredEntries[0] ?? null;

  useEffect(() => {
    if (selectedEntry && selectedEntry.id !== selectedId) setSelectedId(selectedEntry.id);
  }, [selectedEntry, selectedId]);

  const selectLetter = (letter: string) => {
    const candidate = filteredEntries.find((entry) => entry.term[0].toLocaleUpperCase('it') === letter);
    if (candidate) setSelectedId(candidate.id);
  };

  return (
    <div className="glossary-page">
      <header className="glossary-page__hero">
        <div>
          <span className="glossary-kicker">Strumenti / Glossario</span>
          <h1>Glossario</h1>
          <p>Spiegazioni semplici, esempi concreti e avvertenze per capire l’app anche se non sei del mestiere.</p>
        </div>
      </header>

      <div className="glossary-controls">
        <div className="glossary-controls__top">
          <label className="glossary-search">
            <Search size={19} aria-hidden="true" />
            <span className="sr-only">Cerca nel glossario</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca un termine o una definizione" aria-label="Cerca nel glossario" />
          </label>
          <div className="glossary-categories" aria-label="Categorie del glossario">
            {(Object.keys(CATEGORY_GROUPS) as CategoryGroup[]).map((item) => (
              <button type="button" key={item} className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}>{item}</button>
            ))}
          </div>
        </div>
        <nav className="glossary-alphabet" aria-label="Indice alfabetico">
          {letters.map((letter) => <button type="button" key={letter} onClick={() => selectLetter(letter)}>{letter}</button>)}
        </nav>
      </div>

      {filteredEntries.length === 0 ? (
        <div className="glossary-empty">Nessuna definizione corrisponde ai filtri.</div>
      ) : (
        <>
          <div className="glossary-desktop-layout">
            <nav className="glossary-index" aria-label="Elenco termini">
              {filteredEntries.map((entry, index) => {
                const letter = entry.term[0].toLocaleUpperCase('it');
                const showLetter = index === 0 || filteredEntries[index - 1].term[0].toLocaleUpperCase('it') !== letter;
                return <React.Fragment key={entry.id}>
                  {showLetter && <div className="glossary-index__letter">{letter}</div>}
                  <button type="button" className={selectedEntry?.id === entry.id ? 'is-active' : ''} onClick={() => setSelectedId(entry.id)}><span>{entry.term}</span><small>{entry.category}</small></button>
                </React.Fragment>;
              })}
            </nav>
            {selectedEntry && <article className="glossary-detail-card" id={selectedEntry.id}><EntryDetails entry={selectedEntry} /></article>}
          </div>

          <div className="glossary-mobile-list">
            {filteredEntries.map((entry, index) => (
              <details className="glossary-entry" id={entry.id} key={entry.id} open={index === 0}>
                <summary className="glossary-entry__header"><span><small>{entry.category}</small><strong>{entry.term}</strong></span><ChevronDown size={19} /></summary>
                <EntryDetails entry={entry} showHeading={false} />
              </details>
            ))}
          </div>
        </>
      )}

      <footer className="glossary-footer">Le definizioni aiutano a interpretare l’app: non trasformano una previsione in una certezza.</footer>
    </div>
  );
};

export default GlossaryPage;
