/**
 * A timer, and nothing else.
 *
 * A Worker cannot touch the Web Audio graph, so it does not schedule anything.
 * What it provides is the one thing the main thread cannot: a `setInterval`
 * that keeps its period when the tab goes to the background. Mobile browsers
 * throttle main-thread timers to once a second or worse, which would starve a
 * 150 ms lookahead window and leave holes in the music the moment a musician
 * glances at a notification.
 */

export type SchedulerCommand = { type: "start"; intervalMs: number } | { type: "stop" };

let timer: ReturnType<typeof setInterval> | null = null;

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

self.onmessage = (event: MessageEvent<SchedulerCommand>) => {
  const command = event.data;
  if (command.type === "stop") {
    stop();
    return;
  }
  stop();
  timer = setInterval(() => {
    (self as unknown as Worker).postMessage("tick");
  }, command.intervalMs);
};
