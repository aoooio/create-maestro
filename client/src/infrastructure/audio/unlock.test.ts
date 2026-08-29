import { afterEach, describe, expect, it, vi } from "vitest";

import {
  restartPlaybackKeepAlive,
  startPlaybackKeepAlive,
  stopPlaybackKeepAlive,
} from "./unlock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("playback keep-alive (§5.5)", () => {
  it("starts a looping inline silent element and calls play in the same turn", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const setAttribute = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        loop = false;
        playsInline = false;
        preload = "";
        currentTime = 0;
        play = play;
        pause = vi.fn();
        load = vi.fn();
        setAttribute = setAttribute;
        removeAttribute = vi.fn();
      },
    );

    const element = startPlaybackKeepAlive();
    expect(element).not.toBeNull();
    expect(element?.loop).toBe(true);
    expect(setAttribute).toHaveBeenCalledWith("playsinline", "true");
    expect((element as HTMLAudioElement & { playsInline: boolean }).playsInline).toBe(true);
    expect(play).toHaveBeenCalledOnce();
  });

  it("restarts from the beginning on a later gesture", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const element = {
      currentTime: 1.5,
      play,
    } as unknown as HTMLAudioElement;

    restartPlaybackKeepAlive(element);
    expect(element.currentTime).toBe(0);
    expect(play).toHaveBeenCalledOnce();
  });

  it("releases the media element on stop", () => {
    const element = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLAudioElement;

    stopPlaybackKeepAlive(element);
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.removeAttribute).toHaveBeenCalledWith("src");
    expect(element.load).toHaveBeenCalledOnce();
  });
});
