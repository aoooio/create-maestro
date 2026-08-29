/**
 * iOS treats Web Audio as the Ambient session category, which the hardware
 * silent switch mutes. Playing a looping HTMLAudioElement (even a silent one)
 * promotes the page to Playback, which the switch does not mute (§5.5).
 *
 * `play()` must be invoked from a user gesture, in the same turn as
 * `new AudioContext()` / `resume()` — awaiting anything else first spends the
 * activation and leaves the context suspended.
 */

/** One 16-bit silent sample. Short enough to loop cheaply, long enough for
 * WebKit to accept it as a real media element. */
const SILENCE_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export function startPlaybackKeepAlive(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  const element = new Audio(SILENCE_WAV);
  element.loop = true;
  // Safari iOS: without playsinline the element may hijack the audio session
  // into a phone-call route. The DOM lib here does not type the property.
  element.setAttribute("playsinline", "true");
  (element as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  element.preload = "auto";
  // Not `muted`: a muted element does not always retarget the audio session.
  // The file itself is silence, so nothing is heard.
  void element.play().catch(() => {
    // Gesture already spent, or autoplay denied. The resume overlay is the
    // fallback; failing here must not abort AudioContext creation.
  });
  return element;
}

export function restartPlaybackKeepAlive(element: HTMLAudioElement | null): void {
  if (!element) return;
  element.currentTime = 0;
  void element.play().catch(() => {
    /* same as start: a later tap retries */
  });
}

export function stopPlaybackKeepAlive(element: HTMLAudioElement | null): void {
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
}
