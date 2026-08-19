/**
 * Turns voice specs into decoded `AudioBuffer`s, with progress.
 *
 * The interface is the one the spec asks for — `fetch` + `decodeAudioData` —
 * and a spec carrying a `url` takes exactly that path. A spec without one is
 * rendered into an `OfflineAudioContext` instead. Both come out the far side
 * as buffers, so swapping the whole palette for real files later is a change
 * of manifest and nothing else.
 *
 * Everything is decoded before a musician is allowed on stage (§5.5): a
 * `decodeAudioData` starting mid-performance is a glitch on every phone that
 * hits it at once.
 */

import type { SampleSpec } from "./voices";

export interface LoadedSample {
  readonly buffer: AudioBuffer;
  /** Frequency the buffer was rendered at, for pitched voices. */
  readonly baseFreq?: number;
}

export type SampleBank = ReadonlyMap<string, LoadedSample>;

export interface LoadOptions {
  /** 0..1, for the progress bar. */
  onProgress?: (ratio: number) => void;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetcher?: typeof fetch;
}

/** Rendering rate. 44.1 kHz is what phone hardware runs at, so the buffers do
 * not get resampled on their way out. */
const RENDER_SAMPLE_RATE = 44100;

export async function loadSamples(
  ctx: BaseAudioContext,
  specs: readonly SampleSpec[],
  options: LoadOptions = {},
): Promise<SampleBank> {
  const bank = new Map<string, LoadedSample>();
  let done = 0;

  // Sequential on purpose: rendering six offline contexts at once on a mid
  // range phone stutters the very first bars we are trying to protect.
  for (const spec of specs) {
    const buffer = spec.url
      ? await decodeFile(ctx, spec.url, options.fetcher ?? fetch)
      : await render(spec);
    bank.set(spec.id, { buffer, baseFreq: spec.baseFreq });
    done += 1;
    options.onProgress?.(done / specs.length);
  }

  return bank;
}

async function render(spec: SampleSpec): Promise<AudioBuffer> {
  const frames = Math.ceil(spec.durationSec * RENDER_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, RENDER_SAMPLE_RATE);
  spec.render(offline);
  return offline.startRendering();
}

async function decodeFile(
  ctx: BaseAudioContext,
  url: string,
  fetcher: typeof fetch,
): Promise<AudioBuffer> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`cannot load sample ${url}: HTTP ${response.status}`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}
