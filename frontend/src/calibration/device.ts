/**
 * Output-device checks (spec §3.3 headphone policy, §7.3 WiredCheck / ChannelCheck).
 *
 * Wired only, Bluetooth blocked: detected by output-device label heuristics AND an
 * explicit user attestation (labels are often generic, or hidden without permission —
 * so the heuristic can only ever block, never clear a device on its own).
 */

const BLUETOOTH_PATTERNS = [
  /bluetooth/i,
  /\bbt\b/i,
  /air\s?pods/i,
  /\bbuds\b/i,
  /galaxy buds/i,
  /hands-?free/i,
  /\bhfp\b/i,
  /\ba2dp\b/i,
  /wireless/i,
  /beats (solo|studio|flex|fit)/i,
  /\bwh-1000/i,
  /\bwf-/i,
  /jabra/i,
];

export function looksLikeBluetooth(label: string): boolean {
  return BLUETOOTH_PATTERNS.some((re) => re.test(label));
}

export interface OutputDeviceSummary {
  readonly labels: readonly string[];
  readonly bluetoothLabels: readonly string[];
  /** Labels are empty until the page has media permission; then nothing can be checked. */
  readonly labelsAvailable: boolean;
}

export async function inspectOutputDevices(
  mediaDevices: Pick<MediaDevices, 'enumerateDevices'> | undefined = globalThis.navigator?.mediaDevices,
): Promise<OutputDeviceSummary> {
  if (!mediaDevices) return { labels: [], bluetoothLabels: [], labelsAvailable: false };
  const devices = await mediaDevices.enumerateDevices();
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  const labels = outputs.map((d) => d.label).filter((l) => l.length > 0);
  return { labels, bluetoothLabels: labels.filter(looksLikeBluetooth), labelsAvailable: labels.length > 0 };
}

/** Channel check: present each ear in random order; every answer must be right. */
export function channelCheckOrder(random: () => number = Math.random, rounds = 4): ('left' | 'right')[] {
  const order: ('left' | 'right')[] = [];
  for (let i = 0; i < rounds; i++) order.push(i % 2 === 0 ? 'left' : 'right');
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Digital level for channel-check tones before calibration exists (moderate; [DESIGN]). */
export const CHANNEL_CHECK_DBFS = -45;
