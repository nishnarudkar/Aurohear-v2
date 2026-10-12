/**
 * Export the audiogram as a standalone SVG or a high-resolution PNG (browser only).
 * The SVG uses concrete colours (no CSS variables), so the file looks identical outside
 * the app.
 */

import { renderAudiogram, type AudiogramData, type RenderOptions } from './renderAudiogram';
import { serialize } from './svg';

export function audiogramSvgString(data: AudiogramData, opts: RenderOptions = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(renderAudiogram(data, opts))}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadAudiogramSvg(data: AudiogramData, opts: RenderOptions = {}, filename = 'audiogram.svg'): void {
  download(new Blob([audiogramSvgString(data, opts)], { type: 'image/svg+xml' }), filename);
}

/** Rasterise at `scale` × the SVG's size (default 3× ≈ print resolution). */
export async function audiogramPngBlob(data: AudiogramData, opts: RenderOptions = {}, scale = 3): Promise<Blob> {
  const svg = audiogramSvgString(data, opts);
  const size = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  const width = Number(size?.[1] ?? 800);
  const height = Number(size?.[2] ?? 800);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not rasterise the audiogram SVG'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadAudiogramPng(data: AudiogramData, opts: RenderOptions = {}, filename = 'audiogram.png', scale = 3): Promise<void> {
  download(await audiogramPngBlob(data, opts, scale), filename);
}
