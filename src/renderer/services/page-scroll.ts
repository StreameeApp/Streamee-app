export interface ScrollPort {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

// Keep the requested position separate from the browser's temporary clamp while
// cached content and virtual spacers are being mounted.
export function createPageScrollSession(container: ScrollPort, position: number) {
  const target = Math.max(0, Number.isFinite(position) ? position : 0);
  let pending = true;
  let saved = target;

  return {
    get pending() { return pending; },
    restore(ready: boolean, acceptClamp = false) {
      if (!pending || !ready) return;
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.min(target, maximum);
      if (maximum >= target || acceptClamp) {
        pending = false;
        saved = container.scrollTop;
      }
    },
    capture() {
      if (!pending) saved = container.scrollTop;
    },
    interrupt() {
      pending = false;
      saved = container.scrollTop;
    },
    get position() { return saved; },
  };
}
