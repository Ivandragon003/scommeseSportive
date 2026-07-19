import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GLOSSARY_ENTRIES, getGlossaryEntry } from './glossaryEntries';
import { GlossaryEntry } from './glossaryTypes';
import './glossary.css';

interface GlossaryContextValue {
  openGlossary: (termId?: string) => void;
  closeGlossary: () => void;
  selectedEntry: GlossaryEntry | null;
}

const GlossaryContext = createContext<GlossaryContextValue>({
  openGlossary: () => undefined,
  closeGlossary: () => undefined,
  selectedEntry: null,
});

export const useGlossary = () => useContext(GlossaryContext);

interface GlossaryProviderProps {
  children: React.ReactNode;
}

export const GlossaryProvider: React.FC<GlossaryProviderProps> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const openGlossary = useCallback((termId?: string) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(termId && getGlossaryEntry(termId) ? termId : null);
    setQuery('');
    setIsOpen(true);
  }, []);

  const closeGlossary = useCallback(() => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      openGlossary(typeof detail?.termId === 'string' ? detail.termId : undefined);
    };
    window.addEventListener('glossary-open', handleOpen);
    return () => window.removeEventListener('glossary-open', handleOpen);
  }, [openGlossary]);

  useEffect(() => {
    if (!isOpen) return undefined;
    searchRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeGlossary();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusableElements = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusableElements.length === 0) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeGlossary, isOpen]);

  const selectedEntry = getGlossaryEntry(selectedId);
  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('it');
    if (!normalizedQuery) return GLOSSARY_ENTRIES.slice(0, 12);
    return GLOSSARY_ENTRIES.filter((entry) =>
      [
        entry.term,
        entry.acronym,
        ...(entry.aliases ?? []),
        entry.simpleDefinition,
        entry.category,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('it')
        .includes(normalizedQuery)
    ).slice(0, 20);
  }, [query]);

  const contextValue = useMemo(
    () => ({ openGlossary, closeGlossary, selectedEntry }),
    [closeGlossary, openGlossary, selectedEntry]
  );

  return (
    <GlossaryContext.Provider value={contextValue}>
      {children}
      {isOpen && (
        <div className="glossary-drawer-backdrop" onMouseDown={closeGlossary}>
          <aside
            ref={drawerRef}
            className="glossary-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="glossary-drawer-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="glossary-drawer__header">
              <div>
                <span className="glossary-kicker">Aiuto contestuale</span>
                <h2 id="glossary-drawer-title">Glossario rapido</h2>
              </div>
              <button
                type="button"
                className="glossary-icon-button"
                onClick={closeGlossary}
                aria-label="Chiudi glossario rapido"
              >
                <X size={18} />
              </button>
            </div>

            <label className="glossary-search glossary-search--drawer">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">Cerca nel glossario rapido</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedId(null);
                }}
                placeholder="Cerca ROI, quota, Kelly…"
                aria-label="Cerca nel glossario rapido"
              />
            </label>

            <div className="glossary-drawer__body">
              {selectedEntry ? (
                <article className="glossary-quick-entry">
                  <span className="glossary-category-label">{selectedEntry.category}</span>
                  <h3>{selectedEntry.term}</h3>
                  <p className="glossary-lead">{selectedEntry.simpleDefinition}</p>
                  <dl className="glossary-quick-facts">
                    <div>
                      <dt>Come leggerlo</dt>
                      <dd>{selectedEntry.interpretation}</dd>
                    </div>
                    <div>
                      <dt>Esempio</dt>
                      <dd>{selectedEntry.example}</dd>
                    </div>
                    <div>
                      <dt>Attenzione</dt>
                      <dd>{selectedEntry.caution}</dd>
                    </div>
                  </dl>
                  <Link
                    className="fp-btn fp-btn-solid"
                    to={`/glossary#${selectedEntry.id}`}
                    onClick={closeGlossary}
                  >
                    Apri definizione completa
                  </Link>
                </article>
              ) : (
                <div className="glossary-quick-list" aria-live="polite">
                  {filteredEntries.length > 0 ? (
                    filteredEntries.map((entry) => (
                      <button
                        type="button"
                        className="glossary-quick-list__item"
                        key={entry.id}
                        onClick={() => setSelectedId(entry.id)}
                      >
                        <span>
                          <strong>{entry.term}</strong>
                          <small>{entry.category}</small>
                        </span>
                        <span aria-hidden="true">Apri</span>
                      </button>
                    ))
                  ) : (
                    <div className="glossary-empty">
                      Nessun termine corrisponde alla ricerca. Prova con un acronimo o una parola più breve.
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </GlossaryContext.Provider>
  );
};
