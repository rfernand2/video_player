// Maps media time <-> frame index.
//
// Starts out assuming a constant frame rate (available instantly from the
// probe). Once the real presentation timestamps have been read from the file
// (setTimes) it switches to them, which makes stepping exact for
// variable-frame-rate video too. For constant-rate files both agree.

const EPS = 1e-3; // seconds of slack when comparing timestamps

export class FrameMap {
  constructor({ fps, startTime = 0, frameCount = 0, duration = 0 }) {
    this.fps = fps > 0 ? fps : 30;
    this.startTime = startTime;
    // Duration is preferred over the container's frame count, which also
    // counts frames that a trimmed file hides with an edit list.
    this.cfrCount = Math.max(1, Math.floor((duration - startTime) * this.fps + 0.01) || frameCount);
    this.times = null;
  }

  /**
   * Constant-rate estimate only: the first frame was seen at media time `t`.
   * (Files don't always start exactly at their declared start time.)
   */
  calibrate(firstFrameTime) {
    if (!this.times && Number.isFinite(firstFrameTime)) this.startTime = firstFrameTime;
  }

  /** @param {Float64Array} times sorted presentation time of every frame */
  setTimes(times) {
    if (times && times.length > 0) this.times = times;
  }

  get exact() { return this.times !== null; }

  get count() { return this.times ? this.times.length : this.cfrCount; }

  /** Index of the frame on screen at media time `t`. */
  frameAt(t) {
    const n = this.times
      ? upperBound(this.times, t + EPS) - 1
      : Math.floor((t - this.startTime) * this.fps + EPS * this.fps);
    return clamp(n, 0, this.count - 1);
  }

  /** Index of the frame whose start is closest to `t` (for timestamps from another tool). */
  nearest(t) {
    const n = this.frameAt(t);
    return n + 1 < this.count && this.timeOf(n + 1) - t < t - this.timeOf(n) ? n + 1 : n;
  }

  /** Presentation time of frame `n`. */
  timeOf(n) {
    n = clamp(n, 0, this.count - 1);
    return this.times ? this.times[n] : this.startTime + n / this.fps;
  }

  /** How long frame `n` stays on screen. */
  durationOf(n) {
    if (!this.times || this.times.length < 2) return 1 / this.fps;
    n = clamp(n, 0, this.times.length - 1);
    return n + 1 < this.times.length
      ? this.times[n + 1] - this.times[n]
      : this.times[n] - this.times[n - 1];
  }

  /** A time safely inside frame `n` (its midpoint) — what to seek to. */
  seekTime(n) {
    return this.timeOf(n) + this.durationOf(n) / 2;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** First index whose value is > x (array sorted ascending). */
export function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}
