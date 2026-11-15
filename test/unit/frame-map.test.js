import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameMap } from '../../shared/frame-map.js';

test('constant frame rate: frame boundaries and seek targets', () => {
  const fps = 24000 / 1001;
  const map = new FrameMap({ fps, frameCount: 100 });
  assert.equal(map.count, 100);
  for (const n of [0, 1, 2, 47, 99]) {
    assert.equal(map.frameAt(map.timeOf(n)), n, `start of frame ${n}`);
    assert.equal(map.frameAt(map.seekTime(n)), n, `middle of frame ${n}`);
    assert.equal(map.frameAt(map.timeOf(n) + 0.99 / fps - 0.002), n, `end of frame ${n}`);
  }
  assert.equal(map.frameAt(-5), 0);
  assert.equal(map.frameAt(1e6), 99);
});

test('constant frame rate honours a non-zero start time and derives the count from duration', () => {
  const map = new FrameMap({ fps: 25, startTime: 0.08, duration: 4.08 });
  assert.equal(map.count, 100);
  assert.equal(map.timeOf(0), 0.08);
  assert.equal(map.frameAt(0.08), 0);
  assert.equal(map.frameAt(0.125), 1);
});

test('constant frame rate can be calibrated to where the first frame really is', () => {
  // A losslessly trimmed clip: declared start 0, first visible frame a little later,
  // and a container frame count that includes the hidden lead-in.
  const map = new FrameMap({ fps: 24, startTime: 0, duration: 8.7, frameCount: 240 });
  assert.equal(map.count, 208);
  map.calibrate(0.033333);
  for (const n of [0, 1, 50]) {
    assert.equal(map.frameAt(0.033333 + n / 24), n);
    assert.equal(map.frameAt(map.seekTime(n)), n);
  }
  map.setTimes(Float64Array.of(0.033333, 0.075));
  map.calibrate(5); // no effect once real timestamps are known
  assert.equal(map.timeOf(0), 0.033333);
});

test('exact timestamps: variable frame durations', () => {
  const map = new FrameMap({ fps: 22.5, frameCount: 5 });
  map.setTimes(Float64Array.of(0, 0.033333, 0.1, 0.133333, 0.166667));
  assert.equal(map.exact, true);
  assert.equal(map.count, 5);
  assert.equal(map.frameAt(0.033333), 1);
  assert.equal(map.frameAt(0.09), 1);       // frame 1 is held for two source intervals
  assert.equal(map.frameAt(0.0999995), 2);  // microsecond rounding still lands on frame 2
  assert.ok(Math.abs(map.durationOf(1) - 0.066667) < 1e-9);
  assert.equal(map.frameAt(map.seekTime(1)), 1);
  assert.equal(map.frameAt(map.seekTime(4)), 4);
  assert.ok(Math.abs(map.durationOf(4) - 0.033334) < 1e-9); // last frame borrows the previous duration
});

test('nearest snaps a slightly-off timestamp to the frame that starts closest to it', () => {
  const map = new FrameMap({ fps: 24, frameCount: 100 });
  assert.equal(map.nearest(2), 48);
  assert.equal(map.nearest(2.007), 48);  // a little late
  assert.equal(map.nearest(1.995), 48);  // a little early
  assert.equal(map.nearest(2.03), 49);
  assert.equal(map.nearest(-1), 0);
  assert.equal(map.nearest(1e6), 99);
});

test('an empty timestamp table is ignored', () => {
  const map = new FrameMap({ fps: 30, frameCount: 10 });
  map.setTimes(new Float64Array(0));
  assert.equal(map.exact, false);
  assert.equal(map.count, 10);
});
