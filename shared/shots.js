// Shot detection from per-frame scene scores, and shot lookup/navigation.
//
// `scores[i]` is ffmpeg's scene score for frame i (0..1): how much frame i
// differs from frame i-1, discounted when the previous frame differed just as
// much (steady motion). A cut shows up as a spike on the first frame of the
// new shot. The frame after it often scores a little too: its change is
// measured against the cut's, so the new shot's motion isn't discounted.

import { upperBound } from './frame-map.js';

/**
 * @param {ArrayLike<number>} times  presentation time of each analysed frame
 * @param {ArrayLike<number>} scores scene score of each analysed frame
 * @returns {number[]} time of the first frame of every shot after the first
 */
export function findCuts(times, scores, {
  threshold = 0.3,
  adaptiveFloor = 0.5,
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

/**
 * Does scores[i] stand out from the other scores within minShotSec? It must be
 * at least `ratio` times all of them but one, and at least twice that one.
 * The exception is usually the frame after the cut (see the top of this file),
 * or a single jump in the picture just before or after it.
 */
function standsOut(times, scores, n, i, ratio, minShotSec) {
  let highest = 0;
  let second = 0;
  const add = (score) => {
    if (score > highest) [highest, second] = [score, highest];
    else if (score > second) second = score;
  };
  for (let j = i - 1; j >= 0 && times[i] - times[j] <= minShotSec; j--) add(scores[j]);
  for (let j = i + 1; j < n && times[j] - times[i] <= minShotSec; j++) add(scores[j]);
  return highest <= scores[i] / 2 && second <= scores[i] / ratio;
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
