import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Timecode } from '../../shared/timecode.js';

test('non-drop timecode counts frames at the rounded rate', () => {
  const tc = new Timecode({ fps: 23.976 });
  assert.equal(tc.format(0), '00:00:00:00');
  assert.equal(tc.format(23), '00:00:00:23');
  assert.equal(tc.format(24), '00:00:01:00');
  assert.equal(tc.format(24 * 3600 + 24 * 61 + 5), '01:01:01:05');
});

test('parse inverts format', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
    for (const dropFrame of [false, true]) {
      const tc = new Timecode({ fps, dropFrame, startFrame: 1234 });
      for (const frame of [0, 1, 29, 30, 1799, 1800, 1801, 17981, 17982, 107892, 123456]) {
        assert.equal(tc.parse(tc.format(frame)), frame, `${fps} df=${dropFrame} frame ${frame}`);
      }
    }
  }
});

test('drop-frame skips ;00 and ;01 each minute except every tenth', () => {
  const tc = new Timecode({ fps: 29.97, dropFrame: true });
  assert.equal(tc.format(1799), '00:00:59;29');
  assert.equal(tc.format(1800), '00:01:00;02');
  assert.equal(tc.format(17981), '00:09:59;29');
  assert.equal(tc.format(17982), '00:10:00;00');
  assert.equal(tc.format(107892), '01:00:00;00'); // one hour of real time
});

test('drop-frame at 59.94 drops four numbers', () => {
  const tc = new Timecode({ fps: 59.94, dropFrame: true });
  assert.equal(tc.format(3599), '00:00:59;59');
  assert.equal(tc.format(3600), '00:01:00;04');
});

test('drop-frame is ignored at rates that do not use it', () => {
  assert.equal(new Timecode({ fps: 24, dropFrame: true }).dropFrame, false);
  assert.equal(new Timecode({ fps: 30, dropFrame: true }).dropFrame, false);
  assert.equal(new Timecode({ fps: 29.97, dropFrame: true }).dropFrame, true);
});

test('embedded start timecode offsets the count and selects drop-frame', () => {
  const ndf = Timecode.fromStart('01:00:00:00', 24);
  assert.equal(ndf.format(0), '01:00:00:00');
  assert.equal(ndf.format(25), '01:00:01:01');
  assert.equal(ndf.parse('01:00:01:01'), 25);

  const df = Timecode.fromStart('01:00:00;00', 29.97);
  assert.equal(df.dropFrame, true);
  assert.equal(df.format(0), '01:00:00;00');
  assert.equal(df.format(1800), '01:01:00;02');

  assert.equal(Timecode.fromStart('01:00:00;00', 29.97, false).format(0), '01:00:00:00');
  assert.equal(Timecode.fromStart(null, 25).format(50), '00:00:02:00');
});

test('parse finds a timecode inside other text and rejects junk', () => {
  const tc = new Timecode({ fps: 25 });
  assert.equal(tc.parse('### Shot 3 · 00:00:02:10'), 60);
  assert.equal(tc.parse('no timecode here'), null);
  assert.equal(tc.parse(null), null);
});
