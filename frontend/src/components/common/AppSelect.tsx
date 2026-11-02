import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './app-select.css';
type Option = { value: string; label: string };

export const AppSelect: React.FC<{
  value: string; options: Option[]; onChange: (value: string) => void;
  id?: string; className?: string; 'aria-label'?: string;
}> = ({ value, options, onChange, id, className = '', 'aria-label': ariaLabel }) => {
  const uid = useId(); const listId = `${uid}-options`; const triggerId = id || `${uid}-trigger`;
  const trigger = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 220, maxHeight: 280 });
  const selected = options.findIndex(option => option.value === value);
  const show = () => { setActive(Math.max(0, selected)); setOpen(true); };
  const choose = (index: number) => { if (options[index]) onChange(options[index].value); setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = Math.min(280, Math.max(below, above), options.length * 44 + 12);
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: below >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), maxHeight: height });
    };
    place();
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', place); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true); };
  }, [open, options.length]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' }); }, [open, active, listId]);
  const typed = useRef({ value: '', at: 0 });
  return <><button ref={trigger} id={triggerId} value={value} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox"
    aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined}
    className={`app-select ${className}`} onClick={() => open ? setOpen(false) : show()}
    onBlur={event => { if (!menu.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); event.preventDefault(); return; }
      if (event.key === 'Tab') { setOpen(false); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!open) { show(); return; }
        setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return;
      }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (open) choose(active); else show(); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        typed.current = { value: (Date.now() - typed.current.at > 600 ? '' : typed.current.value) + event.key.toLocaleLowerCase(), at: Date.now() };
        const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(typed.current.value));
        if (index >= 0) { setActive(index); setOpen(true); }
      }
    }}><span>{options[selected]?.label || options[0]?.label || 'Seleziona'}</span><ChevronDown size={16} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} className="app-select-menu" id={listId} role="listbox" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : triggerId}
      style={{ position: 'fixed', ...position }} onPointerDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" aria-selected={option.value === value}
        data-value={option.value} className={`app-select-option${active === index ? ' is-focused' : ''}`}
        onPointerMove={() => setActive(index)} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}</div>)}
    </div>, document.body)}
  </>;
};
export const AppDateInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = props => <input {...props} type="date" />;
