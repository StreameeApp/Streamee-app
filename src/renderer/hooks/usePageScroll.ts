import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../store';
import { createPageScrollSession } from '../services/page-scroll';

type Options = {
  key: string;
  position: number;
  save: (position: number) => void;
  ready?: boolean;
  onRestored?: () => void;
};

export function usePageScroll({ key, position, save, ready = true, onRestored }: Options) {
  const latest = useRef({ position, save, ready, onRestored });
  latest.current = { position, save, ready, onRestored };
  const restoreRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = document.querySelector<HTMLElement>('.main-content');
    if (!container) return;
    const content = container.querySelector<HTMLElement>('.main-content-inner');
    const session = createPageScrollSession(container, latest.current.position);
    const savePosition = latest.current.save;
    // All pages share this element. Clear the outgoing offset while loading.
    container.scrollTop = 0;
    let frame = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      const wasPending = session.pending;
      session.restore(latest.current.ready);
      if (wasPending && !session.pending) latest.current.onRestored?.();
      if (session.pending && latest.current.ready && deadline === undefined) {
        // Content can legitimately shrink after a removal or a window resize.
        deadline = setTimeout(() => {
          deadline = undefined;
          const wasPending = session.pending;
          session.restore(latest.current.ready, true);
          if (wasPending && !session.pending) latest.current.onRestored?.();
        }, 1500);
      }
    };
    restoreRef.current = restore;
    const schedule = () => {
      if (!session.pending) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    const capture = () => session.capture();
    const interrupt = (event: Event) => {
      if (event instanceof KeyboardEvent && ![
        'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ',
      ].includes(event.key)) return;
      session.interrupt();
    };
    container.addEventListener('scroll', capture, { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown']) {
      container.addEventListener(type, interrupt, { passive: true });
    }
    window.addEventListener('keydown', interrupt);
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    if (content) resize.observe(content);
    const mutations = new MutationObserver(schedule);
    if (content) mutations.observe(content, { childList: true, subtree: true });
    const view = useStore.getState().view;
    // Capture synchronously before React replaces the outgoing page's DOM.
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.view !== view && previous.view === view) session.capture();
    });
    restore();

    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      clearTimeout(deadline);
      resize.disconnect();
      mutations.disconnect();
      container.removeEventListener('scroll', capture);
      for (const type of ['wheel', 'touchstart', 'pointerdown']) {
        container.removeEventListener(type, interrupt);
      }
      window.removeEventListener('keydown', interrupt);
      restoreRef.current = null;
      savePosition(session.position);
    };
  }, [key]);

  useLayoutEffect(() => {
    restoreRef.current?.();
  });
}

const positions = new Map<string, number>();

export function useCachedPageScroll(key: string, ready = true) {
  usePageScroll({
    key,
    position: positions.get(key) ?? 0,
    save: (position) => {
      positions.delete(key);
      positions.set(key, position);
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
    },
    ready,
  });
}
