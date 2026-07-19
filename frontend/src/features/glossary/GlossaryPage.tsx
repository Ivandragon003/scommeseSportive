import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { GLOSSARY_ENTRIES } from './glossaryEntries';
import { GLOSSARY_CATEGORIES, GlossaryCategory } from './glossaryTypes';

const ALL_CATEGORIES = 'Tutte le categorie';

const GlossaryPage: React.FC = () => {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GlossaryCategory | typeof ALL_CATEGORIES>(ALL_CATEGORIES);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('it');
    return GLOSSARY_ENTRIES.filter((entry) => {
      if (category !== ALL_CATEGORIES && entry.category !== category) return false;
      if (!normalizedQuery) return true;
      return [
        entry.term,
        entry.acronym,
        ...(entry.aliases ?? []),
        entry.simpleDefinition,
        entry.technicalDefinition,
        entry.category,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('it')
        .includes(normalizedQuery);
    });
  }, [category, query]);

  const letters = useMemo(
    () => Array.from(new Set(GLOSSARY_ENTRIES.map((entry) => entry.term[0].toLocaleUpperCase('it')))).sort(),
    []
  );

  return (
    <div className="glossary-page">
      <header className="glossary-page__hero">
        <div>
          <span className="glossary-kicker">Impara mentre analizzi</span>
          <h1>Glossario</h1>
          <p>
            Definizioni operative per quote, mercati, bankroll, modelli e backtesting.
            Ogni voce spiega anche come leggere valori alti, bassi, positivi e negativi.
          </p>
        </div>
        <div className="glossary-page__count" aria-label={`${GLOSSARY_ENTRIES.length} termini disponibili`}>
          <strong>{GLOSSARY_ENTRIES.length}</strong>
          <span>termini documentati</span>
        </div>
      </header>

      <div className="glossary-controls">
        <label className="glossary-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Cerca nel glossario</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cerca ROI, quota implicita, walk-forward…"
            aria-label="Cerca nel glossario"
          />
        </label>
        <div className="glossary-categories" aria-label="Categorie del glossario">
          {[ALL_CATEGORIES, ...GLOSSARY_CATEGORIES].map((item) => (
            <button
              type="button"
              key={item}
              className={category === item ? 'is-active' : ''}
              onClick={() => setCategory(item as GlossaryCategory | typeof ALL_CATEGORIES)}
            >
              {item}
            </button>
          ))}
        </div>
        <nav className="glossary-alphabet" aria-label="Indice alfabetico">
          {letters.map((letter) => (
            <a key={letter} href={`#letter-${letter}`}>
              {letter}
            </a>
          ))}
        </nav>
      </div>

      <div className="glossary-results-meta" aria-live="polite">
        {filteredEntries.length} {filteredEntries.length === 1 ? 'definizione trovata' : 'definizioni trovate'}
      </div>

      {filteredEntries.length === 0 ? (
        <div className="glossary-empty">
          Nessuna definizione corrisponde ai filtri. Rimuovi una categoria o prova una parola più breve.
        </div>
      ) : (
        <div className="glossary-list">
          {filteredEntries.map((entry, index) => {
            const firstOfLetter =
              index === 0 ||
              filteredEntries[index - 1].term[0].toLocaleUpperCase('it') !== entry.term[0].toLocaleUpperCase('it');
            const letter = entry.term[0].toLocaleUpperCase('it');
            return (
              <React.Fragment key={entry.id}>
                {firstOfLetter && (
                  <div className="glossary-letter" id={`letter-${letter}`} aria-hidden="true">
                    {letter}
                  </div>
                )}
                <article className="glossary-entry" id={entry.id}>
                  <header className="glossary-entry__header">
                    <div>
                      <span className="glossary-category-label">{entry.category}</span>
                      <h2>{entry.term}</h2>
                    </div>
                    {entry.acronym && <span className="glossary-entry__acronym">{entry.acronym}</span>}
                  </header>
                  <p className="glossary-lead">{entry.simpleDefinition}</p>
                  <p>{entry.technicalDefinition}</p>
                  {entry.formula && (
                    <div className="glossary-formula">
                      <span>Formula</span>
                      <code>{entry.formula}</code>
                    </div>
                  )}
                  <dl className="glossary-detail-grid">
                    <div>
                      <dt>Esempio pratico</dt>
                      <dd>{entry.example}</dd>
                    </div>
                    <div>
                      <dt>Valore alto</dt>
                      <dd>{entry.highValue}</dd>
                    </div>
                    <div>
                      <dt>Valore basso</dt>
                      <dd>{entry.lowValue}</dd>
                    </div>
                    <div>
                      <dt>Quando è positivo</dt>
                      <dd>{entry.positiveMeaning}</dd>
                    </div>
                    <div>
                      <dt>Quando è negativo</dt>
                      <dd>{entry.negativeMeaning}</dd>
                    </div>
                    <div>
                      <dt>Come interpretarlo</dt>
                      <dd>{entry.interpretation}</dd>
                    </div>
                  </dl>
                  <div className="glossary-caution">
                    <strong>Attenzione</strong>
                    <span>{entry.caution}</span>
                  </div>
                  {entry.relatedTerms.length > 0 && (
                    <div className="glossary-related">
                      <span>Termini correlati</span>
                      <div>
                        {entry.relatedTerms
                          .map((id) => GLOSSARY_ENTRIES.find((candidate) => candidate.id === id))
                          .filter(Boolean)
                          .map((related) => (
                            <a key={related?.id} href={`#${related?.id}`}>
                              {related?.term}
                            </a>
                          ))}
                      </div>
                    </div>
                  )}
                </article>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default GlossaryPage;
