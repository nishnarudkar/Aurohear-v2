/**
 * Headphone selection, wired check and L/R channel check (spec §3.3, §7.3
 * HeadphoneSelector / WiredCheck / ChannelCheck). Bluetooth is blocked; the channel check
 * is blocking — swapped headphones are caught here.
 */

import { useEffect, useState } from 'react';

import type { ToneStimulusEngine } from '../../audio/ToneStimulusEngine';
import { dbfsToRawLevel } from '../../calibration/biological';
import { CHANNEL_CHECK_DBFS, channelCheckOrder, inspectOutputDevices, type OutputDeviceSummary } from '../../calibration/device';
import type { DeviceSetup } from '../appFlowMachine';

type Ear = 'left' | 'right';
const TRANSDUCERS: { value: DeviceSetup['transducerType']; label: string }[] = [
  { value: 'circumaural', label: 'Over-ear headphones (cover the whole ear) — recommended' },
  { value: 'supra_aural', label: 'On-ear headphones (rest on the ear)' },
  { value: 'insert', label: 'In-ear earphones (sit inside the ear canal)' },
  { value: 'other', label: 'Other / not sure' },
];

export function DeviceScreen({
  engine,
  onConfirmed,
  inspect = inspectOutputDevices,
}: {
  readonly engine: ToneStimulusEngine;
  readonly onConfirmed: (d: DeviceSetup) => void;
  readonly inspect?: () => Promise<OutputDeviceSummary>;
}) {
  const [transducer, setTransducer] = useState<DeviceSetup['transducerType'] | ''>('');
  const [wired, setWired] = useState(false);
  const [noAnc, setNoAnc] = useState(false);
  const [devices, setDevices] = useState<OutputDeviceSummary | null>(null);
  const [step, setStep] = useState<'select' | 'channel'>('select');

  useEffect(() => {
    void inspect().then(setDevices, () => setDevices({ labels: [], bluetoothLabels: [], labelsAvailable: false }));
  }, [inspect]);

  const bluetooth = devices?.bluetoothLabels ?? [];
  const canContinue = transducer !== '' && wired && noAnc && bluetooth.length === 0;

  if (step === 'channel' && transducer !== '') {
    return (
      <ChannelCheck
        engine={engine}
        onPassed={() =>
          onConfirmed({ transducerType: transducer, outputLabel: devices?.labels[0] ?? null, wiredAttested: true, channelCheckPassed: true })
        }
      />
    );
  }

  return (
    <>
      <h1>Your headphones</h1>
      <fieldset>
        <legend>What kind of headphones are you using?</legend>
        {TRANSDUCERS.map((t) => (
          <div key={t.value}>
            <label>
              <input type="radio" name="transducer" checked={transducer === t.value} onChange={() => setTransducer(t.value)} />
              {t.label}
            </label>
          </div>
        ))}
      </fieldset>
      {bluetooth.length > 0 && (
        <div className="notice danger" role="alert">
          A wireless output was detected ({bluetooth.join(', ')}). Bluetooth headphones change the sound in ways that make
          this test inaccurate. Please plug in <strong>wired</strong> headphones and reload this page.
        </div>
      )}
      <div className="card">
        <label>
          <input type="checkbox" checked={wired} onChange={(e) => setWired(e.target.checked)} />
          My headphones are plugged in with a cable (not Bluetooth or wireless).
        </label>
        <br />
        <label>
          <input type="checkbox" checked={noAnc} onChange={(e) => setNoAnc(e.target.checked)} />
          Noise cancelling, “spatial audio” and sound effects/equaliser are switched off.
        </label>
      </div>
      <div className="actions">
        <button type="button" disabled={!canContinue} onClick={() => setStep('channel')}>
          Continue
        </button>
      </div>
    </>
  );
}

const ROUNDS = 4;

export function ChannelCheck({ engine, onPassed }: { readonly engine: ToneStimulusEngine; readonly onPassed: () => void }) {
  const [order, setOrder] = useState<Ear[]>(() => channelCheckOrder(Math.random, ROUNDS));
  const [round, setRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const [failed, setFailed] = useState(false);

  const play = async (): Promise<void> => {
    setPlaying(true);
    const tone = engine.presentTone({
      ear: order[round]!,
      frequencyHz: 1000,
      levelDbHl: dbfsToRawLevel(CHANNEL_CHECK_DBFS),
      durationMs: 1000,
      isiMs: 300,
    });
    await tone.ended;
    setPlaying(false);
    setPlayed(true);
  };

  const answer = (ear: Ear): void => {
    if (!played || playing) return;
    if (ear !== order[round]) {
      setFailed(true);
      return;
    }
    if (round + 1 === ROUNDS) onPassed();
    else {
      setRound(round + 1);
      setPlayed(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'l' || e.key === 'L') answer('left');
      if (e.key === 'r' || e.key === 'R') answer('right');
      if (e.key === 'p' || e.key === 'P') void play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (failed) {
    return (
      <>
        <h1>Left and right did not match</h1>
        <div className="notice danger" role="alert">
          The tone came from the other side. Your headphones may be on the wrong way round — check the <strong>L</strong>{' '}
          and <strong>R</strong> marks, then try again.
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setOrder(channelCheckOrder(Math.random, ROUNDS));
              setRound(0);
              setPlayed(false);
              setFailed(false);
            }}
          >
            Try again
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Left or right?</h1>
      <p>
        Put your headphones on (L on your left ear). Play the tone, then say which ear you heard it in. Check {round + 1} of{' '}
        {ROUNDS}.
      </p>
      <div className="actions">
        <button type="button" onClick={() => void play()} disabled={playing}>
          {played ? 'Play again' : 'Play tone'} <span className="kbd">P</span>
        </button>
      </div>
      <div className="actions">
        <button type="button" className="secondary" disabled={!played || playing} onClick={() => answer('left')}>
          Left ear <span className="kbd">L</span>
        </button>
        <button type="button" className="secondary" disabled={!played || playing} onClick={() => answer('right')}>
          Right ear <span className="kbd">R</span>
        </button>
      </div>
    </>
  );
}
