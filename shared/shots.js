// Shot detection from per-frame scene scores, and shot lookup/navigation.
//
// `scores[i]` is ffmpeg's scene score for frame i (0..1): how much frame i
// differs from frame i-1, discounted when the previous frame differed just as
// much (steady motion). A cut shows up as a single isolated spike on the
// first frame of the new shot.

import { upperBound } from './frame-map.js';

/**
 * @param {ArrayLike<number>} times  presentation time of each analysed frame
 * @param {ArrayLike<number>} scores scene score of each analysed frame
 * @returns {number[]} time of the first frame of every shot after the first
 */
export function findCuts(times, scores, {
  threshold = 0.3,
  adaptiveFloor = 0.25,
  adaptiveRatio = 6,
  minShotSec = 0.25,
} = {}) {
  const n = Math.min(times.length, scores.length);
  const floor = adaptiveRatio > 0 ? threshold * adaptiveFloor : threshold;
  const cuts = [];
  let lastIdx = -1; // index (into times) of the most recently accepted cut

  // Frames 0 and 1 are skipped: ffmpeg has nothing to compare them against yet.
  for (let i = 2; i < n; i++) {
    const s = scores[i];
    if (s < floor) continue;
    if (s < threshold && !standsOut(times, scores, n, i, adaptiveRatio, minShotSec)) continue;

    if (lastIdx >= 0 && times[i] - times[lastIdx] < minShotSec) {
      // Too close to the previous cut: keep whichever is stronger.
      if (s > scores[lastIdx]) {
        cuts[cuts.length - 1] = times[i];
        lastIdx = i;
      }
      continue;
    }
    cuts.push(times[i]);
    lastIdx = i;
  }
  return cuts;
}

/** Is scores[i] at least `ratio` times every other score within minShotSec? */
function standsOut(times, scores, n, i, ratio, minShotSec) {
  const limit = scores[i] / ratio;
  for (let j = i - 1; j >= 0 && times[i] - times[j] <= minShotSec; j--) {
    if (scores[j] > limit) return false;
  }
  for (let j = i + 1; j < n && times[j] - times[i] <= minShotSec; j++) {
    if (scores[j] > limit) return false;
  }
  return true;
}

/** Shots as ranges of frame numbers. */
export class ShotList {
  /**
   * @param {number[]} cuts first frame of shots 2..N, ascending
   * @param {number} knownUntil last frame analysed so far
   *        (Infinity once the whole file has been analysed, -1 for none)
   */
  constructor(cuts = [], knownUntil = Infinity) {
    this.cuts = cuts;
    this.knownUntil = knownUntil;
  }

  get count() { return this.cuts.length + 1; }

  /** 1-based number of the shot containing `frame`, or null where not yet analysed. */
  numberAt(frame) {
    if (frame > this.knownUntil) return null;
    return upperBound(this.cuts, frame) + 1;
  }

  /** First frame of the next shot, or null if `frame` is in the last known shot. */
  nextStart(frame) {
    const i = upperBound(this.cuts, frame);
    return i < this.cuts.length ? this.cuts[i] : null;
  }

  /**
   * First frame of the current shot — or of the previous one if `frame` is
   * already that. Returns null when the answer is the first shot (frame 0).
   */
  prevStart(frame) {
    const i = upperBound(this.cuts, frame - 1) - 1;
    return i >= 0 ? this.cuts[i] : null;
  }
}
