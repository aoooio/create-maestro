/**
 * What the engine requires of anything it has started.
 *
 * A rendered sample and a synthesised note have almost nothing in common, but
 * a tempo change has to be able to take either of them back (§5.4) — and that
 * is the whole of what the engine needs to know. Keeping the contract in one
 * place is what lets `AudioBufferSourceNode`, the acid bass and the group
 * synth all sit in the same list of live sources.
 */
export interface StoppableVoice {
  stop(when?: number): void;
}
