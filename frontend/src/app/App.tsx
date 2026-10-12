/** Top-level app: drives appFlowMachine and owns the non-serialisable runtime objects. */

import { useMachine } from '@xstate/react';
import { useCallback, useRef } from 'react';

import { settleSession } from '../api/ApiSessionClient';
import type { ApiBackedTestSession } from '../api/createApiBackedTestSession';
import type { ToneStimulusEngine } from '../audio/ToneStimulusEngine';
import type { SessionResult } from '../session/testSessionMachine';
import { appFlowMachine } from './appFlowMachine';
import { useTheme } from './components/common';
import { createSetupAudio, createTestEngine, createTestRun, sessionCreateBody, type SetupAudio, testProfile } from './runtime';
import { CalibrationScreen } from './screens/CalibrationScreen';
import { DeviceScreen } from './screens/DeviceScreen';
import { InstructionScreen } from './screens/InstructionScreen';
import { HaltScreen, IntakeScreen } from './screens/IntakeScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { TestRunnerScreen } from './screens/TestRunnerScreen';
import { WelcomeScreen } from './screens/WelcomeScreen';

export function App() {
  const [state, send] = useMachine(appFlowMachine);
  const [theme, toggleTheme] = useTheme();
  const audio = useRef<SetupAudio | null>(null);
  const testEngine = useRef<ToneStimulusEngine | null>(null);
  const run = useRef<ApiBackedTestSession | null>(null);
  const ctx = state.context;

  const ensureTestEngine = (): ToneStimulusEngine => {
    if (!testEngine.current) {
      testEngine.current = createTestEngine(audio.current!, testProfile(ctx.calibration!), (fault) =>
        run.current?.actor.send({ type: 'FAULT', reason: fault }),
      );
    }
    return testEngine.current;
  };

  // The session settles itself when the machine finishes (run.results); only a
  // user-requested retry calls settleSession again — never both, or the abort is sent twice.
  const settle = useCallback(
    (output: SessionResult, retry: boolean) => {
      const r = run.current!;
      (retry ? settleSession(r.client, output) : r.results).then(
        (results) => send({ type: 'RESULTS_READY', results }),
        (e: unknown) => send({ type: 'RESULTS_FAILED', error: e instanceof Error ? e.message : String(e) }),
      );
    },
    [send],
  );

  let screen: React.ReactNode = null;
  let wide = false;
  if (state.matches('welcome')) {
    screen = (
      <WelcomeScreen
        onStart={async () => {
          audio.current ??= await createSetupAudio();
          send({ type: 'CONSENT_ACCEPTED' });
        }}
      />
    );
  } else if (state.matches('intake')) {
    screen = <IntakeScreen onSubmit={(answers) => send({ type: 'INTAKE_SUBMITTED', answers })} />;
  } else if (state.matches('halted')) {
    screen = <HaltScreen redFlags={ctx.redFlags} />;
  } else if (state.matches('device')) {
    screen = <DeviceScreen engine={audio.current!.engine} onConfirmed={(device) => send({ type: 'DEVICE_CONFIRMED', device })} />;
  } else if (state.matches('calibration')) {
    screen = <CalibrationScreen engine={audio.current!.engine} onCalibrated={(calibration) => send({ type: 'CALIBRATED', calibration })} />;
  } else if (state.matches('instructions')) {
    screen = (
      <InstructionScreen
        engine={ensureTestEngine()}
        onBegin={() => {
          const engine = ensureTestEngine();
          const body = sessionCreateBody(ctx.intake!, ctx.device!, ctx.calibration!, testProfile(ctx.calibration!), audio.current!.context.sampleRate);
          run.current = createTestRun(engine, body);
          send({ type: 'BEGIN_TEST' });
        }}
      />
    );
  } else if (state.matches('testing')) {
    screen = (
      <TestRunnerScreen
        run={run.current!}
        onFinished={(output) => {
          send({ type: 'TEST_FINISHED', output });
          settle(output, false);
        }}
      />
    );
  } else if (state.matches('settling')) {
    screen = ctx.error ? (
      <>
        <h1>We could not save your results yet</h1>
        <div className="notice danger" role="alert">
          {ctx.error}
        </div>
        <p className="muted">Your answers are stored on this device. Check your internet connection and try again.</p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              send({ type: 'RETRY_RESULTS' });
              settle(ctx.testOutput!, true);
            }}
          >
            Try again
          </button>
        </div>
      </>
    ) : (
      <p aria-live="polite">Saving your results…</p>
    );
  } else if (state.matches('results')) {
    wide = true;
    screen = <ResultsScreen results={ctx.results!} theme={theme} client={run.current?.client ?? null} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AuroHear</span>
        <button type="button" className="secondary" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
      </header>
      <main className={`main${wide ? ' wide' : ''}`}>{screen}</main>
    </div>
  );
}
