import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FETCH_TIMEOUT_MS, fetchSlides, pollSlides, REFRESH_MS, RETRY_MS } from "./feed";
import type { Slide } from "./playlist";

const slide: Slide = {
  id: "a",
  src: { src: "/_next/static/media/a.jpg", width: 800, height: 1200, blurDataURL: "data:image/jpeg;base64,AAAA" },
  alt: "Photo a",
  kind: "photo",
  by: "[Guest]",
  detail: "Reception · just now",
};

const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe("fetchSlides", () => {
  it("returns the server's list", async () => {
    expect(await fetchSlides({ fetcher: answer({ slides: [slide] }) })).toEqual([slide]);
  });

  it("accepts an empty list (every photo hidden)", async () => {
    expect(await fetchSlides({ fetcher: answer({ slides: [] }) })).toEqual([]);
  });

  it("returns null when the network fails", async () => {
    const fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchSlides({ fetcher })).toBeNull();
  });

  it("returns null on a server error", async () => {
    expect(await fetchSlides({ fetcher: answer({ slides: [slide] }, 502) })).toBeNull();
  });

  it("returns null for an answer that is not a slide list, such as a proxy's error page", async () => {
    expect(await fetchSlides({ fetcher: async () => new Response("<html>Bad gateway</html>") })).toBeNull();
    expect(await fetchSlides({ fetcher: answer({ slides: [{ id: "a" }] }) })).toBeNull();
    expect(await fetchSlides({ fetcher: answer({ slides: "a" }) })).toBeNull();
  });

  it("gives up after 10 s instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      let result: Slide[] | null | undefined;
      void fetchSlides({ fetcher }).then((slides) => (result = slides));
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets the browser reuse a cached answer", async () => {
    const fetcher = vi.fn(answer({ slides: [] }));
    await fetchSlides({ fetcher });
    expect(fetcher).toHaveBeenCalledWith("/slideshow/slides.json", expect.objectContaining({ cache: "no-store" }));
  });
});

describe("pollSlides", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks again every 30 s and hands over each new list", async () => {
    const load = vi.fn(async () => [slide]);
    const onSlides = vi.fn();
    const stop = pollSlides({ load, onSlides, isHidden: () => false });

    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlides).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(onSlides).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the current list when a refresh fails, and tries again sooner", async () => {
    const load = vi.fn<() => Promise<Slide[] | null>>().mockResolvedValueOnce(null).mockResolvedValue([slide]);
    const onSlides = vi.fn();
    const stop = pollSlides({ load, onSlides, isHidden: () => false });

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onSlides).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onSlides).toHaveBeenCalledWith([slide]);
    stop();
  });

  it("keeps trying through a long outage", async () => {
    const load = vi.fn(async () => null);
    const stop = pollSlides({ load, onSlides: vi.fn(), isHidden: () => false });
    await vi.advanceTimersByTimeAsync(REFRESH_MS + RETRY_MS * 20);
    expect(load).toHaveBeenCalledTimes(21);
    stop();
  });

  it("does not ask while the screen is hidden", async () => {
    let hidden = true;
    const load = vi.fn(async () => [slide]);
    const stop = pollSlides({ load, onSlides: vi.fn(), isHidden: () => hidden });
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(load).not.toHaveBeenCalled();
    hidden = false;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops for good, even with a request still in flight", async () => {
    let finish: (slides: Slide[]) => void = () => {};
    const load = vi.fn(() => new Promise<Slide[] | null>((resolve) => (finish = resolve)));
    const onSlides = vi.fn();
    const stop = pollSlides({ load, onSlides, isHidden: () => false });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    stop();
    finish([slide]);
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(onSlides).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
