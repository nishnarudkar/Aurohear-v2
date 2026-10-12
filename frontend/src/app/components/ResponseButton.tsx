/**
 * The single most important control (spec §7.4): ≥ 96×96 px, Space and Enter bound,
 * pointer/touch/pen supported. The response time is the input event's own `timeStamp`
 * (DOMHighResTimeStamp — same clock as performance.now() and the tone onset mapping),
 * not the time React gets round to handling it. Debouncing is done by the session FSM.
 *
 * It never changes appearance in sync with the stimulus: there is no "listening" state.
 */

import { useEffect } from 'react';

import type { ResponseSource } from '../../session/types';

export interface ResponseButtonProps {
  readonly onResponse: (timestampMs: number, source: ResponseSource) => void;
  readonly label?: string;
  /** Disable the global Space/Enter binding (e.g. while a dialog is open). */
  readonly keyboardEnabled?: boolean;
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export function ResponseButton({ onResponse, label = 'I heard it', keyboardEnabled = true }: ResponseButtonProps) {
  useEffect(() => {
    if (!keyboardEnabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || isTypingTarget(e.target)) return;
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); // no page scroll, no implicit button click
        onResponse(e.timeStamp, 'keyboard');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResponse, keyboardEnabled]);

  return (
    <button
      type="button"
      className="response-button"
      aria-describedby="response-help"
      onPointerDown={(e) => {
        if (e.button > 0) return; // ignore only explicit secondary buttons (right/middle/eraser)
        onResponse(e.timeStamp, e.pointerType === 'touch' ? 'touch' : 'pointer');
      }}
      // Keyboard activation is handled by the window listener above; swallow the
      // synthetic click so a key press can never count twice.
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}
