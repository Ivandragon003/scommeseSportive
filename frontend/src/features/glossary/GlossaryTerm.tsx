import React from 'react';
import { getGlossaryEntry } from './glossaryEntries';
import { useGlossary } from './GlossaryProvider';

interface GlossaryTermProps {
  termId: string;
  children?: React.ReactNode;
  className?: string;
}

const getAccessibleLabel = (children: React.ReactNode, fallback: string) =>
  typeof children === 'string' ? children : fallback;

const GlossaryTerm: React.FC<GlossaryTermProps> = ({ termId, children, className = '' }) => {
  const entry = getGlossaryEntry(termId);
  const { openGlossary } = useGlossary();
  if (!entry) return <>{children ?? termId}</>;

  const visibleLabel = children ?? entry.acronym ?? entry.term;
  const accessibleLabel = getAccessibleLabel(visibleLabel, entry.acronym ?? entry.term);

  return (
    <span className={`glossary-term-wrap${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="glossary-term"
        onClick={() => openGlossary(termId)}
        aria-label={`Spiega ${accessibleLabel}`}
        aria-describedby={`glossary-tooltip-${termId}`}
      >
        {visibleLabel}
      </button>
      <span id={`glossary-tooltip-${termId}`} role="tooltip" className="glossary-tooltip">
        {entry.simpleDefinition}
      </span>
    </span>
  );
};

export default GlossaryTerm;
