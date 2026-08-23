class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([
      {
        target,
        contentRect: { width: 800, height: 300 },
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  unobserve() {}

  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});

export {};
