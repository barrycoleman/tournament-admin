import "@testing-library/jest-dom/vitest";

// jsdom implements no scrolling, so Element.scrollIntoView is missing
// entirely; react-data-grid calls it whenever the active cell moves.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom's selector engine doesn't understand the CSS-nesting `&` that
// react-data-grid uses in its internal lookups (e.g.
// `& > [role="row"] > [tabindex="0"]`, used when it restores focus after
// a cell editor closes) -- it throws a SyntaxError instead. Browsers treat
// a leading `&` in querySelector as `:scope`; make jsdom do the same.
{
  const nativeQuerySelector = Element.prototype.querySelector;
  Element.prototype.querySelector = function querySelector(this: Element, selectors: string) {
    return nativeQuerySelector.call(this, selectors.replace(/(^|,\s*)&/g, "$1:scope"));
  } as typeof Element.prototype.querySelector;
}

// jsdom has the <dialog> element but not showModal()/close(). Modal.tsx
// opens every dialog with showModal(); stand in with the open/close state
// alone (no inert background or focus trapping -- the Playwright tests
// cover those in a real browser).
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

// jsdom has no layout engine and ships no ResizeObserver. react-data-grid
// sizes its viewport from one (falling back to clientWidth/clientHeight,
// which jsdom always reports as 0) and virtualizes away every column and
// row that doesn't fit -- so without this the grid renders exactly one
// cell and component tests can't see it. Report a generous fixed size
// synchronously on observe(), before react-data-grid's clientWidth
// fallback runs. Must be installed before react-data-grid is imported,
// which setupFiles guarantees.
if (!("ResizeObserver" in globalThis)) {
  const TEST_VIEWPORT = { inlineSize: 1920, blockSize: 1080 };

  class TestResizeObserver implements ResizeObserver {
    #callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }

    observe(target: Element): void {
      this.#callback(
        [
          {
            target,
            contentBoxSize: [TEST_VIEWPORT],
            borderBoxSize: [TEST_VIEWPORT],
            devicePixelContentBoxSize: [TEST_VIEWPORT],
            contentRect: new DOMRect(0, 0, TEST_VIEWPORT.inlineSize, TEST_VIEWPORT.blockSize),
          } as unknown as ResizeObserverEntry,
        ],
        this
      );
    }

    unobserve(): void {}

    disconnect(): void {}
  }

  globalThis.ResizeObserver = TestResizeObserver;
}
