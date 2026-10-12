/**
 * Ambient-noise pre-test gate (spec §5.3.1, §7.3 AmbientNoiseMeter): 15 s capture,
 * ⅓-octave bars, pass/fail with actionable advice, "Recheck noise" (R).
 *
 * Blocking (spec §5.2 — boothless testing is defensible only if noise is measured):
 *   - no microphone / permission denied;
 *   - echo cancellation, AGC or noise suppression could not be switched off (§4.1);
 *   - a Bluetooth output is visible now that device labels are readable (§3.3).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { type BandLevels, THIRD_OCTAVE_BANDS_HZ } from '../../audio/noiseBands';
import { NoiseMonitor, PRETEST_DURATION_MS, pretestDecision, type PretestResult } from '../../audio/NoiseGate';
import { inspectOutputDevices } from '../../calibration/device';
import { NOISE_ABSOLUTE_CONFIG } from '../config';

const FRAME_MS = 100;

type Phase =
  | { kind: 'intro' }
  | { kind: 'error'; message: string }
  | { kind: 'measuring'; startedAt: number }
  | { kind: 'done'; result: PretestResult };

export interface EnvironmentScreenProps {
  readonly openMonitor: () => Promise<NoiseMonitor>;
  readonly onPassed: (result: PretestResult, monitor: NoiseMonitor) => void;
  readonly inspect?: typeof inspectOutputDevices;
}

const label = (b: number): string => (b >= 1000 ? `${b / 1000}k` : String(b));

export function EnvironmentScreen({ openMonitor, onPassed, inspect = inspectOutputDevices }: EnvironmentScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const [live, setLive] = useState<BandLevels | null>(null);
  const monitor = useRef<NoiseMonitor | null>(null);
  const frames = useRef<BandLevels[]>([]);

  const measure = useCallback(async () => {
    try {
      monitor.current ??= await openMonitor();
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setPhase({
        kind: 'error',
        message: denied
          ? 'Microphone access was refused. The test needs the microphone to check that the room is quiet enough; please allow it and try again.'
          : 'No microphone could be used. The test cannot run without checking the room noise.',
      });
      return;
    }
    const m = monitor.current;
    if (!m.status.processingOff) {
      setPhase({
        kind: 'error',
        message: 'This browser kept its microphone "noise suppression" or "auto gain" switched on, which makes the noise check meaningless. Please try another browser (for example Chrome or Firefox).',
      });
      return;
    }
    const devices = await inspect().catch(() => null);
    if (devices && devices.bluetoothLabels.length > 0) {
      setPhase({ kind: 'error', message: `A wireless audio device is connected (${devices.bluetoothLabels.join(', ')}). Please use wired headphones only.` });
      return;
    }
    frames.current = [];
    const startedAt = performance.now();
    setPhase({ kind: 'measuring', startedAt });
    m.start((t, bands) => {
      frames.current.push(bands);
      setLive(bands);
      if (t - startedAt >= PRETEST_DURATION_MS) {
        m.stop();
        setPhase({ kind: 'done', result: pretestDecision(frames.current, { absolute: NOISE_ABSOLUTE_CONFIG, framesPerSecond: 1000 / FRAME_MS }) });
      }
    }, FRAME_MS);
  }, [openMonitor, inspect]);

  useEffect(() => () => monitor.current?.stop(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'r' || e.key === 'R') && (phase.kind === 'done' || phase.kind === 'error')) void measure();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, measure]);

  const relative = NOISE_ABSOLUTE_CONFIG === null;
  return (
    <>
      <h1>Check the room is quiet</h1>
      <p>
        We listen to the room for 15 seconds through your microphone. Nothing is recorded or sent — only the noise level is
        measured. Keep still and quiet while it listens, and keep the microphone where it will be during the test.
      </p>
      {relative && (
        <p className="muted small">
          This microphone is not calibrated, so the check compares the room with itself and watches for noise during the test;
          it cannot state an exact sound level (±8 dB). This is recorded with your results.
        </p>
      )}

      {phase.kind === 'intro' && (
        <div className="actions">
          <button type="button" onClick={() => void measure()}>
            Allow microphone and check
          </button>
        </div>
      )}

      {phase.kind === 'error' && (
        <>
          <div className="notice danger" role="alert">
            {phase.message}
          </div>
          <div className="actions">
            <button type="button" onClick={() => void measure()}>
              Try again <span className="kbd">R</span>
            </button>
          </div>
        </>
      )}

      {(phase.kind === 'measuring' || phase.kind === 'done') && live && <Meter bands={live} result={phase.kind === 'done' ? phase.result : null} />}
      {phase.kind === 'measuring' && <p aria-live="polite">Listening… please stay quiet.</p>}

      {phase.kind === 'done' && phase.result.pass && (
        <>
          <div className="notice ok" role="status">
            The room is quiet enough{phase.result.dba !== null ? ` (about ${Math.round(phase.result.dba)} dB(A))` : ''}. We will keep
            listening between tones during the test.
          </div>
          <div className="actions">
            <button type="button" onClick={() => onPassed(phase.result, monitor.current!)}>
              Continue
            </button>
          </div>
        </>
      )}
      {phase.kind === 'done' && !phase.result.pass && (
        <>
          <div className="notice danger" role="alert">
            <ul style={{ margin: 0 }}>
              {phase.result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <p>Try: closing windows and doors, switching off fans, TV, music or appliances, and moving away from traffic.</p>
          <div className="actions">
            <button type="button" onClick={() => void measure()}>
              Recheck noise <span className="kbd">R</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Live ⅓-octave bars (relative scale) with per-band pass/fail when limits exist. */
function Meter({ bands, result }: { readonly bands: BandLevels; readonly result: PretestResult | null }) {
  const values = THIRD_OCTAVE_BANDS_HZ.map((b) => bands[b]);
  const top = Math.max(...values) + 6;
  const floor = top - 60;
  return (
    <div className="card" aria-label="Room noise by pitch">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
        {THIRD_OCTAVE_BANDS_HZ.map((b) => {
          const v = bands[b];
          const limit = result?.limits[b];
          const over = result !== null && result.mode === 'absolute' && limit !== undefined && result.meanBands[b] > limit;
          const h = Math.max(2, Math.min(100, ((v - floor) / (top - floor)) * 100));
          return (
            <div key={b} style={{ flex: 1, textAlign: 'center' }} title={`${label(b)} Hz`}>
              <div
                style={{ height: `${h}%`, minHeight: 2, background: over ? 'var(--danger)' : 'var(--accent)', borderRadius: 2 }}
                data-band={b}
                data-over={over ? 'true' : 'false'}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 4 }} className="small muted" aria-hidden="true">
        {THIRD_OCTAVE_BANDS_HZ.map((b) => (
          <div key={b} style={{ flex: 1, textAlign: 'center', fontSize: '0.65rem' }}>
            {[250, 500, 1000, 2000, 4000, 8000].includes(b) ? label(b) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
