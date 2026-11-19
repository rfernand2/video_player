// End-to-end test: launches the real app and drives it with the keyboard.
//   npm run test:e2e
// Needs ffmpeg on PATH. Opens an app window for about half a minute.
//
// The test videos carry their frame number as black/white squares (see
// media.mjs), which lets the test read back from the screen which frame is
// actually displayed, independently of what the app believes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { _electron as electron } from 'playwright-core';
import { BITS, BOX, SIZE, ensureMedia, videos } from './media.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-player-e2e-'));
const media = {};
let app;
let page;
const errors = [];

async function launch(...files) {
  app = await electron.launch({
    cwd: ROOT,
    args: [
      ROOT,
      `--user-data-dir=${path.join(work, 'user-data')}`,
      '--force-device-scale-factor=1',
      // Keep rendering even if the test window ends up behind other windows.
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...files,
    ],
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.waitForFunction(() => window.vp !== undefined);
}

before(async () => {
  ensureMedia();
  for (const [name, { file }] of Object.entries(videos)) {
    media[name] = path.join(work, `${name}.mp4`); // copies, so notes land in the temp dir
    fs.copyFileSync(file, media[name]);
  }
  await launch(media.shots);
});

after(async () => {
  await app?.close();
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// Helpers

const text = (selector) => page.locator(selector).innerText();
const press = (key, times = 1) => (async () => {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
})();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the player has landed on `frame` and nothing is in flight. */
async function settle(frame) {
  try {
    await page.waitForFunction((n) => {
      const p = window.vp.player;
      return p.frame === n && p.position === n && !p.busy;
    }, frame, { timeout: 10_000 });
  } catch {
    assert.fail(`expected to settle on frame ${frame}, player is on ${await page.evaluate(() => window.vp.player.frame)}`);
  }
}

/** The frame number painted into the picture currently on screen. */
async function frameOnScreen() {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const pic = await page.evaluate(() => {
    const r = document.getElementById('picture').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const y = pic.y + ((BOX.y + BOX.size / 2) / SIZE.height) * pic.height;
  const strip = { x: Math.floor(pic.x), y: Math.round(y), width: Math.ceil(pic.width), height: 1 };
  const shot = await app.evaluate(async ({ BrowserWindow }, rect) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
    return { ...image.getSize(), bgra: image.toBitmap().toString('base64') };
  }, strip);
  const bgra = Buffer.from(shot.bgra, 'base64');
  assert.equal(bgra.length, shot.width * shot.height * 4, 'unexpected capture size');
  let n = 0;
  for (let k = 0; k < BITS; k++) {
    const x = Math.round(pic.x - strip.x + ((k * BOX.pitch + 2 + BOX.size / 2) / SIZE.width) * pic.width);
    const luma = (bgra[x * 4] + bgra[x * 4 + 1] + bgra[x * 4 + 2]) / 3;
    if (luma > 128) n |= 1 << k;
  }
  return n;
}

/** Settle on `frame` and check that the screen and the overlay agree. */
async function expectFrame(frame, timecode, onScreen = frame) {
  await settle(frame);
  const seen = [await frameOnScreen()];
  // Allow the compositor a few frames to paint what the player just reported —
  // but not long: a picture that lags behind the timecode is a bug (see the
  // note on the `still` canvas in renderer/player.js).
  for (let i = 0; seen.at(-1) !== onScreen && i < 3; i++) {
    await pause(50);
    seen.push(await frameOnScreen());
  }
  if (seen.length > 1) console.log(`# screen showed ${seen.join(' -> ')} while settling on frame ${frame}`);
  assert.equal(seen.at(-1), onScreen, `frame visible on screen (saw ${seen.join(', ')})`);
  if (timecode) assert.equal(await text('#tc'), timecode, 'timecode overlay');
}

async function openInApp(file) {
  await page.evaluate((f) => window.vp.openVideo(f), file);
  await page.waitForFunction((f) => window.vp.media?.path === f && window.vp.player.map.exact, file);
}

async function seek(frame) {
  await page.evaluate((n) => window.vp.player.seekFrame(n), frame);
  await settle(frame);
}

async function addNote(lines) {
  await press('Control+N');
  await page.locator('#note-editor textarea').waitFor({ state: 'visible' });
  for (const [i, line] of lines.entries()) {
    if (i > 0) await press('Shift+Enter');
    await page.keyboard.type(line);
  }
  await press('Enter');
  await page.locator('#note-editor').waitFor({ state: 'hidden' });
  for (let i = 0; !(fs.existsSync(notesFile()) && readNotes().includes(lines.at(-1))); i++) {
    assert.ok(i < 50, `note "${lines[0]}" was not written to ${notesFile()}`);
    await pause(100);
  }
}

const notesFile = () => media.shots.replace(/\.mp4$/, '.md');
const readNotes = () => fs.readFileSync(notesFile(), 'utf8');

// ---------------------------------------------------------------------------

test('opens the video given on the command line, timecode overlay on the picture', async () => {
  await page.waitForFunction(() => window.vp.media !== null);
  assert.match(await page.title(), /^shots\.mp4/);
  await expectFrame(0, '00:00:00:00');
  assert.match(await text('#tc-sub'), /Frame 0$/);

  const [overlay, picture] = await page.evaluate(() => ['overlay', 'picture'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }));
  assert.ok(overlay.left >= picture.left && overlay.top >= picture.top
    && overlay.right <= picture.right && overlay.bottom <= picture.bottom, 'overlay lies inside the picture');

  await press('t');
  assert.equal(await page.locator('#overlay').isVisible(), false);
  await press('t');
  assert.equal(await page.locator('#overlay').isVisible(), true);
});

test('left / right arrows step one frame', async () => {
  await press('ArrowRight', 5);
  await expectFrame(5, '00:00:00:05');
  await press('ArrowLeft', 2);
  await expectFrame(3, '00:00:00:03');
  await press('ArrowRight', 30); // faster than seeks complete: none may be lost
  await expectFrame(33, '00:00:01:09');
  await press('Shift+ArrowRight');
  await expectFrame(57, '00:00:02:09');
  await press('Shift+ArrowLeft');
  await expectFrame(33, '00:00:01:09');
  await press('ArrowLeft', 40); // clamps at the first frame
  await expectFrame(0, '00:00:00:00');
  await page.waitForFunction(() => window.vp.player.map.exact); // real timestamps took over
  await press('ArrowRight', 33);
  await expectFrame(33, '00:00:01:09');
});

test('shots are detected; up / down arrows step between them', async () => {
  await page.waitForFunction(() => window.vp.scene.complete, null, { timeout: 30_000 });
  assert.deepEqual(await page.evaluate(() => window.vp.shots.cuts), videos.shots.cuts);
  assert.match(await text('#shots-label'), /^Shots 6$/);

  await press('ArrowDown');
  await expectFrame(48, '00:00:02:00');
  assert.match(await text('#tc-sub'), /^Shot 2 /);
  await press('ArrowDown', 2);
  await expectFrame(144, '00:00:06:00');
  assert.match(await text('#tc-sub'), /^Shot 4 /);
  await press('ArrowUp'); // already at the start of shot 4: go to shot 3
  await expectFrame(84);
  await press('ArrowRight', 3);
  await expectFrame(87);
  assert.match(await text('#tc-sub'), /^Shot 3 /);
  await press('ArrowUp'); // mid-shot: back to its first frame
  await expectFrame(84);
  await press('End');
  await expectFrame(239, '00:00:09:23');
  assert.match(await text('#tc-sub'), /^Shot 6 /);
  await press('ArrowDown'); // no next shot
  await pause(150);
  await expectFrame(239);
  await press('ArrowUp');
  await expectFrame(204);
  await press('Home');
  await expectFrame(0);
});

test('space plays and pauses; the overlay follows playback', async () => {
  await press('Space');
  await page.waitForFunction(() => window.vp.player.playing && window.vp.player.frame > 12);
  assert.notEqual(await text('#tc'), '00:00:00:00');
  await press('Space');
  await page.waitForFunction(() => !window.vp.player.playing);
  const frame = await page.evaluate(() => window.vp.player.frame);
  assert.ok(frame > 12 && frame < 120, `paused on frame ${frame}`);
  await expectFrame(frame);
  await press('ArrowRight'); // stepping resumes exactly from where playback stopped
  await expectFrame(frame + 1);

  await page.locator('#stage').click({ position: { x: 300, y: 200 } }); // clicking the picture toggles too
  await page.waitForFunction(() => window.vp.player.playing);
  await page.locator('#stage').click({ position: { x: 300, y: 200 } });
  await page.waitForFunction(() => !window.vp.player.playing);
});

test('audio scrubbing plays a snippet per step and can be switched off', async () => {
  await page.waitForFunction(() => window.vp.scrubber.available);
  const rms = await page.evaluate(async () => {
    const pcm = await window.api.readAudio(16000, 3200);
    return Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length);
  });
  assert.ok(rms > 1000, `scrub track is audible (rms ${rms.toFixed(0)})`);

  const played = () => page.evaluate(() => window.vp.scrubber.played);
  const scrubButton = page.locator('#scrub');
  assert.equal(await scrubButton.getAttribute('aria-pressed'), 'true');

  let count = await played();
  await press('ArrowRight');
  await page.waitForFunction((n) => window.vp.scrubber.played === n + 1, count);
  assert.equal(await page.evaluate(() => window.vp.scrubber._ctx.state), 'running');

  await press('s'); // off with the key
  assert.equal(await scrubButton.getAttribute('aria-pressed'), 'false');
  count = await played();
  await press('ArrowRight', 3);
  await pause(300);
  assert.equal(await played(), count, 'silent while switched off');

  await scrubButton.click(); // on again with the button
  assert.equal(await scrubButton.getAttribute('aria-pressed'), 'true');
  await press('ArrowLeft');
  await page.waitForFunction((n) => window.vp.scrubber.played > n, count);

  // Dragging along the timeline scrubs too.
  count = await played();
  const bar = await page.locator('#timeline').boundingBox();
  await page.mouse.move(bar.x + bar.width * 0.25, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2, { steps: 12 });
  await page.mouse.up();
  await settle(await page.evaluate(() => window.vp.player.position));
  const frame = await page.evaluate(() => window.vp.player.frame);
  assert.ok(Math.abs(frame - 120) <= 1, `dragged to the middle (frame ${frame})`);
  assert.ok(await played() > count, 'scrubbed while dragging');
  await expectFrame(frame);
});

test('Ctrl+N writes notes to the .md file, in timecode order, grouped by shot', async () => {
  assert.equal(fs.existsSync(notesFile()), false);

  await seek(100);
  await press('Control+N');
  assert.equal(await text('#note-editor .note-heading'), 'Shot 3 · 00:00:04:04');
  await press('ArrowRight'); // typing keys do not drive the player
  await press('Space');
  await press('Escape');
  await page.locator('#note-editor').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.vp.player.position), 100);
  assert.equal(fs.existsSync(notesFile()), false, 'cancelling writes nothing');

  await addNote(['Third shot, first note']);
  await seek(10);
  await addNote(['Opening', 'second line']);
  await seek(130);
  await addNote(['Third shot, later']);

  assert.equal(readNotes(), [
    '# Notes — shots.mp4',
    '',
    '## Shot 1',
    '',
    '### Shot 1 · 00:00:00:10',
    '',
    'Opening',
    'second line',
    '',
    '## Shot 3',
    '',
    '### Shot 3 · 00:00:04:04',
    '',
    'Third shot, first note',
    '',
    '### Shot 3 · 00:00:05:10',
    '',
    'Third shot, later',
    '',
  ].join('\n'));
  assert.equal(await page.evaluate(() => window.vp.timeline.notes.length), 3);
});

test('edits made to the notes file outside the app are kept', async () => {
  fs.appendFileSync(notesFile(), '\n### 00:00:02:00\n\nAdded in a text editor\n');
  await seek(220);
  await addNote(['Last shot']);
  const headings = readNotes().split('\n').filter((line) => line.startsWith('#'));
  assert.deepEqual(headings, [
    '# Notes — shots.mp4',
    '## Shot 1',
    '### Shot 1 · 00:00:00:10',
    '## Shot 2',
    '### Shot 2 · 00:00:02:00',
    '## Shot 3',
    '### Shot 3 · 00:00:04:04',
    '### Shot 3 · 00:00:05:10',
    '## Shot 6',
    '### Shot 6 · 00:00:09:04',
  ]);
  assert.match(readNotes(), /Added in a text editor/);
  assert.equal(await page.evaluate(() => window.vp.timeline.notes.length), 5);
});

test('changing the shot threshold re-cuts and renumbers the notes', async () => {
  const setThreshold = (value) => page.evaluate((v) => {
    const slider = document.getElementById('threshold');
    slider.value = v;
    slider.dispatchEvent(new Event('input'));
  }, value);
  // The grey-to-grey cut is weak: found at the default threshold (0.3) only because it is
  // isolated and above the adaptive floor (0.15); at 0.5 the floor (0.25) drops it.
  const subtle = await page.evaluate((frame) => window.vp.scene.scores[frame], videos.shots.subtleCut);
  assert.ok(subtle > 0.15 && subtle < 0.25, `subtle cut scores ${subtle.toFixed(3)}`);

  await setThreshold(0.5);
  assert.equal(await page.evaluate(() => window.vp.shots.count), 5, 'the subtle cut is dropped');
  await pause(1200); // the notes file follows after a short debounce
  assert.match(readNotes(), /^### Shot 5 · 00:00:09:04$/m, 'note renumbered');
  assert.doesNotMatch(readNotes(), /^## Shot 6$/m);

  await setThreshold(0.3);
  assert.equal(await page.evaluate(() => window.vp.shots.count), 6);
  await pause(1200);
  assert.match(readNotes(), /^## Shot 6\n\n### Shot 6 · 00:00:09:04\n\nLast shot$/m);
});

test('variable frame rate: every real frame is reachable, none twice', async () => {
  await openInApp(media.vfr);
  assert.equal(await page.evaluate(() => window.vp.player.map.count), videos.vfr.frames);
  for (let i = 0; i < 14; i++) {
    await expectFrame(i, null, videos.vfr.sourceFrame(i));
    await press('ArrowRight');
  }
  await press('End');
  await expectFrame(89, null, videos.vfr.sourceFrame(89));
  assert.equal(await page.locator('#scrub').isDisabled(), true, 'no audio track, no scrubbing');
});

test('embedded drop-frame start timecode is used', async () => {
  await openInApp(media.timecode);
  await expectFrame(0, '01:00:00;00');
  await press('ArrowRight', 30);
  await expectFrame(30, '01:00:01;00');
});

test('dropped files resolve to a path through the preload bridge', async () => {
  const result = await page.evaluate(() => window.api.pathForFile(new File(['x'], 'not-on-disk.mp4')));
  assert.equal(result, ''); // a synthetic File has no path; a real drop returns one
});

test('restart: reopens the last video at the last position, from cache', async () => {
  await app.close();
  await launch();
  await page.waitForFunction(() => window.vp.media?.name === 'timecode.mp4' && window.vp.scene.complete);
  await expectFrame(30, '01:00:01;00');
});

test('no errors were logged', () => {
  assert.deepEqual(errors, []);
});
