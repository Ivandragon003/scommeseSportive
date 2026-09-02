import { applyTheme, getInitialTheme } from './App';

describe('tema applicazione', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: jest.fn().mockReturnValue({ matches: false }) });
  });

  test('usa la preferenza salvata e la mantiene sul documento', () => {
    window.localStorage.setItem('footpredictor-theme', 'dark');
    expect(getInitialTheme()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('footpredictor-theme')).toBe('light');
  });
});
