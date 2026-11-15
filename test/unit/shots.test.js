import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShotList, findCuts } from '../../shared/shots.js';

const FPS = 25;
/** Scores for `count` frames: `base` everywhere, overridden by {frame: score}. */
function track(count, base, spikes = {}) {
  const times = Array.from({ length: count }, (_, i) => i / FPS);
  const scores = times.map((_, i) => spikes[i] ?? base);
  return [times, scores];
}
const frames = (cuts) => cuts.map((t) => Math.round(t * FPS));

test('scores at or above the threshold are cuts', () => {
  const [times, scores] = track(200, 0.01, { 50: 0.8, 120: 0.3, 160: 0.29 });
  assert.deepEqual(frames(findCuts(times, scores, { threshold: 0.3, adaptiveRatio: 0 })), [50, 120]);
});

test('the first two frames are never a cut', () => {
  const [times, scores] = track(50, 0.01, { 0: 1, 1: 0.9 });
  assert.deepEqual(findCuts(times, scores), []);
});

test('a quiet cut counts when it stands out from its neighbours', () => {
  const [times, scores] = track(200, 0.005, { 80: 0.12 });
  assert.deepEqual(frames(findCuts(times, scores, { threshold: 0.3 })), [80]);
  // ...but not below the adaptive floor (0.3 * 0.25 = 0.075)
  const [t2, s2] = track(200, 0.005, { 80: 0.07 });
  assert.deepEqual(findCuts(t2, s2, { threshold: 0.3 }), []);
});

test('busy motion below the threshold is not a cut', () => {
  const [times, scores] = track(200, 0.06, { 80: 0.12, 81: 0.1, 83: 0.11 });
  assert.deepEqual(findCuts(times, scores, { threshold: 0.3 }), []);
});

test('cuts closer than minShotSec merge into the strongest', () => {
  const [times, scores] = track(200, 0.01, { 100: 0.5, 102: 0.9, 104: 0.6, 150: 0.7 });
  assert.deepEqual(frames(findCuts(times, scores, { threshold: 0.3, minShotSec: 0.25 })), [102, 150]);
});

test('ShotList numbers shots and navigates between them', () => {
  const list = new ShotList([20, 50, 90]); // shots: 0-19, 20-49, 50-89, 90-
  assert.equal(list.count, 4);
  assert.equal(list.numberAt(0), 1);
  assert.equal(list.numberAt(19), 1);
  assert.equal(list.numberAt(20), 2);
  assert.equal(list.numberAt(1000), 4);

  assert.equal(list.nextStart(0), 20);
  assert.equal(list.nextStart(19), 20);
  assert.equal(list.nextStart(20), 50);
  assert.equal(list.nextStart(90), null);

  assert.equal(list.prevStart(30), 20);   // mid-shot: back to its first frame
  assert.equal(list.prevStart(21), 20);
  assert.equal(list.prevStart(20), null); // on the first frame of shot 2: back to shot 1
  assert.equal(list.prevStart(50), 20);
  assert.equal(list.prevStart(5), null);
  assert.equal(list.prevStart(0), null);
});

test('ShotList does not guess beyond the analysed part', () => {
  const list = new ShotList([20], 40);
  assert.equal(list.numberAt(30), 2);
  assert.equal(list.numberAt(40), 2);
  assert.equal(list.numberAt(41), null);
  assert.equal(new ShotList([], -1).numberAt(0), null);
});
