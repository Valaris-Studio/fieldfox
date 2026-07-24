// jsdom implements neither layout (getBoundingClientRect returns zeros — fine for
// us, the positioning MATH is unit-tested separately as a pure function) nor the
// observers the trigger uses. Stub them so the element can mount under test and
// so disconnect-cleanup can be asserted via prototype spies.
//
// Methods live on the prototype (not as class fields) so vi.spyOn(Proto, 'disconnect')
// works across instances.

class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class StubIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

globalThis.ResizeObserver = StubResizeObserver;
globalThis.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;
