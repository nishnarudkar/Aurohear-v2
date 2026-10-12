/**
 * DeviceWatchdog (spec §4.1, §7.3): the events that invalidate a test.
 *
 *   devicechange (output device set changed — e.g. headphones unplugged and the browser
 *     falls back to laptop speakers, "the single most common invalidating event")
 *                                                      → 'device_change' (abort)
 *   tab hidden or window blurred                       → 'hidden'  (discard + hold)
 *   tab visible and focused again                      → 'visible' (re-present)
 *
 * AudioContext suspension is reported by ToneStimulusEngine.onFault.
 */

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface WatchdogDeps {
  readonly mediaDevices?: (Pick<MediaDevices, 'enumerateDevices'> & Listenable) | undefined;
  readonly doc?: (Listenable & { readonly visibilityState: DocumentVisibilityState; hasFocus(): boolean }) | undefined;
  readonly win?: Listenable | undefined;
}

export type WatchdogEvent = 'device_change' | 'hidden' | 'visible';

/** Signature of the output devices; inputs too when outputs are not exposed (Firefox/Safari). */
export async function deviceSignature(md: Pick<MediaDevices, 'enumerateDevices'>): Promise<string> {
  const all = await md.enumerateDevices();
  const outputs = all.filter((d) => d.kind === 'audiooutput');
  const relevant = outputs.length ? outputs : all.filter((d) => d.kind === 'audioinput');
  return relevant
    .map((d) => `${d.kind}:${d.deviceId}:${d.label}`)
    .sort()
    .join('|');
}

export class DeviceWatchdog {
  private baseline: string | null = null;
  private hidden = false;
  private readonly md: WatchdogDeps['mediaDevices'];
  private readonly doc: WatchdogDeps['doc'];
  private readonly win: WatchdogDeps['win'];

  constructor(
    private readonly onEvent: (e: WatchdogEvent) => void,
    deps: WatchdogDeps = {
      mediaDevices: globalThis.navigator?.mediaDevices,
      doc: globalThis.document,
      win: globalThis.window,
    },
  ) {
    this.md = deps.mediaDevices;
    this.doc = deps.doc;
    this.win = deps.win;
  }

  async start(): Promise<void> {
    if (this.md) {
      this.baseline = await deviceSignature(this.md);
      this.md.addEventListener('devicechange', this.onDeviceChange);
    }
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.win?.addEventListener('blur', this.onVisibility);
    this.win?.addEventListener('focus', this.onVisibility);
  }

  stop(): void {
    this.md?.removeEventListener('devicechange', this.onDeviceChange);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.win?.removeEventListener('blur', this.onVisibility);
    this.win?.removeEventListener('focus', this.onVisibility);
  }

  private readonly onDeviceChange = async (): Promise<void> => {
    if (!this.md || this.baseline === null) return;
    const now = await deviceSignature(this.md);
    if (now !== this.baseline) this.onEvent('device_change');
  };

  private readonly onVisibility = (e?: Event): void => {
    const doc = this.doc;
    const hiddenNow = !doc || doc.visibilityState !== 'visible' || e?.type === 'blur' || !doc.hasFocus();
    if (hiddenNow && !this.hidden) {
      this.hidden = true;
      this.onEvent('hidden');
    } else if (!hiddenNow && this.hidden) {
      this.hidden = false;
      this.onEvent('visible');
    }
  };
}
