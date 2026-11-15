import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNotes, renderNotes, shotNumbersStale } from '../../shared/notes.js';
import { ShotList } from '../../shared/shots.js';
import { Timecode } from '../../shared/timecode.js';

const tc = new Timecode({ fps: 24 });
const shots = new ShotList([48, 120]); // shots start at 0 s, 2 s, 5 s
const context = {
  title: 'clip.mp4',
  frameOf: (stamp) => tc.parse(stamp),
  shotOf: (frame) => shots.numberAt(frame),
};

test('a new file gets a title, shot groups and per-note headings', () => {
  const doc = parseNotes(null);
  doc.notes.push({ tc: '00:00:03:00', text: 'Second shot.' });
  assert.equal(renderNotes(doc, context), [
    '# Notes — clip.mp4',
    '',
    '## Shot 2',
    '',
    '### Shot 2 · 00:00:03:00',
    '',
    'Second shot.',
    '',
  ].join('\n'));
});

test('notes are kept in timecode order and grouped by shot', () => {
  const doc = parseNotes(null);
  doc.notes.push(
    { tc: '00:00:06:00', text: 'c' },
    { tc: '00:00:02:12', text: 'b2' },
    { tc: '00:00:00:10', text: 'a' },
    { tc: '00:00:02:00', text: 'b1' },
  );
  const out = renderNotes(doc, context);
  assert.deepEqual(out.split('\n').filter((line) => line.startsWith('#')), [
    '# Notes — clip.mp4',
    '## Shot 1',
    '### Shot 1 · 00:00:00:10',
    '## Shot 2',
    '### Shot 2 · 00:00:02:00',
    '### Shot 2 · 00:00:02:12',
    '## Shot 3',
    '### Shot 3 · 00:00:06:00',
  ]);
});

test('render -> parse -> render is stable and keeps hand edits', () => {
  const file = [
    'My own intro, with a [link](x).',
    '',
    '- kept as written',
    '',
    '## Shot 1',
    '',
    '### Shot 1 · 00:00:01:00',
    '',
    'First line.',
    '',
    '  indented second paragraph',
    '',
    '#### a sub-heading inside a note',
    '',
    '## Shot 3',
    '',
    '### Shot 3 · 00:00:05:00',
    '',
    'Last.',
    '',
  ].join('\n');
  const doc = parseNotes(file);
  assert.equal(doc.preamble, 'My own intro, with a [link](x).\n\n- kept as written');
  assert.equal(doc.notes.length, 2);
  assert.equal(doc.notes[0].text, 'First line.\n\n  indented second paragraph\n\n#### a sub-heading inside a note');
  assert.equal(renderNotes(doc, context), file);
});

test('notes at the same timecode keep the order they were added in', () => {
  const doc = parseNotes(null);
  doc.notes.push({ tc: '00:00:01:00', text: 'first' }, { tc: '00:00:01:00', text: 'second' });
  const again = parseNotes(renderNotes(doc, context));
  assert.deepEqual(again.notes.map((n) => n.text), ['first', 'second']);
});

test('Windows line endings and loose heading styles are understood', () => {
  const doc = parseNotes('## Shot 1\r\n\r\n### 00:00:01:00\r\nplain heading\r\n### Shot 9 - 00:00:02:00\r\ndash\r\n');
  assert.deepEqual(doc.notes, [
    { tc: '00:00:01:00', shot: null, text: 'plain heading' },
    { tc: '00:00:02:00', shot: '9', text: 'dash' },
  ]);
});

test('text typed under a shot heading is not lost', () => {
  const doc = parseNotes('## Shot 1\n\n### Shot 1 · 00:00:01:00\n\nnote\n\n## Shot 2\n\nstray thought\n');
  assert.equal(doc.notes[0].text, 'note\n\nstray thought');
});

test('shot numbers are recomputed when detection changes', () => {
  const file = '# T\n\n## Shot 2\n\n### Shot 2 · 00:00:03:00\n\nx\n';
  const doc = parseNotes(file);
  assert.equal(shotNumbersStale(doc, context), false);

  const fewer = { ...context, shotOf: () => 1 };
  assert.equal(shotNumbersStale(doc, fewer), true);
  assert.match(renderNotes(doc, fewer), /## Shot 1\n\n### Shot 1 · 00:00:03:00/);
});

test('a note outside the analysed range is filed under "Shot ?" until detection catches up', () => {
  const pending = { ...context, shotOf: () => null };
  const doc = parseNotes(null);
  doc.notes.push({ tc: '00:00:03:00', text: 'x' });
  const out = renderNotes(doc, pending);
  assert.match(out, /## Shot \?\n\n### Shot \? · 00:00:03:00/);
  assert.equal(shotNumbersStale(parseNotes(out), pending), false);
  assert.equal(shotNumbersStale(parseNotes(out), context), true);
});
