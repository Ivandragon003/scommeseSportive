import React, { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import './app-calendar.css';

export default function AppCalendarInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const panelId = useId();
  const value = String(props.value || '');
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date();
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const choose = (date: Date) => {
    const next = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    props.onChange?.({ target: { value: next }, currentTarget: { value: next } } as React.ChangeEvent<HTMLInputElement>);
    setOpen(false); input.current?.focus();
  };
  const start = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return <div ref={root} className="app-calendar" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); input.current?.focus(); }
  }}>
    <div className="app-calendar__field">
      <input {...props} ref={input} type="date" role="combobox" aria-controls={open ? panelId : undefined} aria-expanded={open} aria-haspopup="dialog"
        onClick={event => { event.preventDefault(); setOpen(current => !current); }}
        onKeyDown={event => { if (event.key === ' ' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }} />
      <CalendarDays size={17} aria-hidden="true" />
    </div>
    {open && <div id={panelId} className="app-calendar__panel" role="dialog" aria-label="Scegli una data">
      <header><button type="button" aria-label="Mese precedente" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={17} /></button>
        <strong aria-live="polite">{month.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</strong>
        <button type="button" aria-label="Mese successivo" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={17} /></button></header>
      <div className="app-calendar__days">{['Lu', 'Ma', 'Me', 'Gi', 'Ve', 'Sa', 'Do'].map(day => <span key={day}>{day}</span>)}
        {Array.from({ length: start }, (_, index) => <span key={`empty-${index}`} />)}
        {Array.from({ length: count }, (_, index) => {
          const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
          const active = !!value && date.toDateString() === selected.toDateString();
          return <button type="button" key={index} aria-pressed={active} aria-label={date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}
            onClick={() => choose(date)}>{index + 1}</button>;
        })}</div>
      <footer><button type="button" onClick={() => { const today = new Date(); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); choose(today); }}>Oggi</button>
        <button type="button" onClick={() => { setOpen(false); input.current?.focus(); }}>Chiudi</button></footer>
    </div>}
  </div>;
}
