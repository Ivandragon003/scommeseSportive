export type GlossaryCategory =
  | 'Mercati di scommessa'
  | 'Quote e probabilità'
  | 'Value betting'
  | 'Gestione del bankroll'
  | 'Rischio e stake'
  | 'Modelli statistici'
  | 'Statistiche calcistiche'
  | 'Backtesting e validazione'
  | 'Fonti e qualità dei dati';

export interface GlossaryEntry {
  id: string;
  term: string;
  acronym?: string;
  aliases?: string[];
  category: GlossaryCategory;
  simpleDefinition: string;
  technicalDefinition: string;
  formula?: string;
  example: string;
  highValue: string;
  lowValue: string;
  positiveMeaning: string;
  negativeMeaning: string;
  interpretation: string;
  caution: string;
  relatedTerms: string[];
}

export const GLOSSARY_CATEGORIES: GlossaryCategory[] = [
  'Mercati di scommessa',
  'Quote e probabilità',
  'Value betting',
  'Gestione del bankroll',
  'Rischio e stake',
  'Modelli statistici',
  'Statistiche calcistiche',
  'Backtesting e validazione',
  'Fonti e qualità dei dati',
];
