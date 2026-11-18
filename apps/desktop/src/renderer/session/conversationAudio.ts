import { useEffect, type RefObject } from 'react';

/** The desktop bridge carries measurements only. */
type Spectrum = { hzPerBin: number; rms: number; powers: string };
/** A null frame releases all active animation after an interruption. */
const spectrumListeners = new Set<(frame: Spectrum | null) => void>();
/** Capture is requested once per renderer, shared by its visible navigators. */
let captureRequested = false;
/** Release both IPC listeners when the last visible rail disappears. */
let releaseBridge: (() => void) | undefined;

/** Reconcile rail mounts in the same turn before touching the shared tap. */
function reconcileCapture(): void {
  queueMicrotask(() => {
    const active = spectrumListeners.size > 0;
    if (active === captureRequested) return;
    const bridge = window.zeus;
    if (!bridge?.subscribeConversationAudio || !bridge.onConversationAudioFrame || !bridge.onConversationAudioUnavailable) return;
    captureRequested = active;
    if (active) {
      const stopFrames = bridge.onConversationAudioFrame((frame) => {
        for (const listener of spectrumListeners) listener(frame);
      });
      const stopStatus = bridge.onConversationAudioUnavailable(() => {
        for (const listener of spectrumListeners) listener(null);
      });
      releaseBridge = () => {
        stopFrames();
        stopStatus();
      };
    } else {
      releaseBridge?.();
      releaseBridge = undefined;
    }
    void bridge.subscribeConversationAudio(active).catch(() => undefined);
  });
}

/** Send spectra to mounted rails without scheduling React renders. */
function listenSpectrum(listener: (frame: Spectrum | null) => void): () => void {
  spectrumListeners.add(listener);
  reconcileCapture();
  return () => {
    spectrumListeners.delete(listener);
    reconcileCapture();
  };
}

/** Read integrated spectrum energy at a fractional FFT-bin boundary. */
function powerAt(prefix: Float64Array, edge: number): number {
  const index = Math.min(Math.floor(edge), prefix.length - 1);
  const power = prefix[index] ?? 0;
  return power + ((prefix[index + 1] ?? power) - power) * (edge - index);
}

/** Attach independent frequency motion to the existing session navigation buttons. */
export function useConversationAudio(railRef: RefObject<HTMLElement | null>, buttonsRef: RefObject<Map<string, HTMLButtonElement>>, entries: readonly { rowKey: string }[]): void {
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || entries.length === 0) return;
    const ticks = entries.map((entry) => buttonsRef.current.get(entry.rowKey));
    const levels = new Float32Array(ticks.length);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const edges = Array.from({ length: ticks.length + 1 }, (_, index) => (50 / 12000) ** (index / ticks.length));
    let release: (() => void) | undefined;
    let intersecting = false;

    /** Return to the built-in idle style when capture stops. */
    function reset(): void {
      levels.fill(0);
      rail?.removeAttribute('data-audio-playing');
      for (const tick of ticks) tick?.style.removeProperty('--conversation-audio-level');
    }

    /** Map one distinct frequency range to each tick and write only visible widths. */
    function update(frame: Spectrum | null): void {
      if (!rail) return;
      const volume = frame ? Math.min(1, Math.max(0, (frame.rms - 0.008) * 6.4)) : 0;
      if (!frame || volume === 0) return reset();
      const bytes = Uint8Array.from(atob(frame.powers), (character) => character.charCodeAt(0));
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return reset();
      const powers = new Float32Array(bytes.buffer);
      const prefix = new Float64Array(powers.length + 1);
      for (const [index, value] of powers.entries()) prefix[index + 1] = prefix[index]! + value;
      const upper = Math.min(powers.length, 12000 / frame.hzPerBin);
      const total = powerAt(prefix, upper) - powerAt(prefix, upper * edges[ticks.length]!);
      if (!(total > 0)) return reset();
      const rowHeight = ticks[0]?.offsetHeight || 10;
      const start = Math.max(0, Math.floor(rail.scrollTop / rowHeight) - 1);
      const end = Math.min(ticks.length, Math.ceil((rail.scrollTop + rail.clientHeight) / rowHeight) + 1);
      rail.setAttribute('data-audio-playing', '');
      for (let index = start; index < end; index += 1) {
        const energy = powerAt(prefix, upper * edges[index]!) - powerAt(prefix, upper * edges[index + 1]!);
        const target = volume * Math.max(0, energy / total) ** 0.32;
        const previous = levels[index]!;
        const next = previous + (target - previous) * (target > previous ? 0.62 : 0.28);
        levels[index] = next;
        ticks[index]?.style.setProperty('--conversation-audio-level', next.toFixed(3));
      }
    }

    /** Observe an active rail only while it is visible and animation is allowed. */
    function reconcileVisibility(): void {
      if (intersecting && document.visibilityState === 'visible' && !reducedMotion.matches) {
        release ??= listenSpectrum(update);
      } else if (release) {
        release();
        release = undefined;
        reset();
      }
    }

    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      reconcileVisibility();
    });
    observer.observe(rail);
    document.addEventListener('visibilitychange', reconcileVisibility);
    reducedMotion.addEventListener('change', reconcileVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', reconcileVisibility);
      reducedMotion.removeEventListener('change', reconcileVisibility);
      release?.();
      reset();
    };
  }, [buttonsRef, entries, railRef]);
}
