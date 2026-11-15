// Wires the UI together. Good places to start customizing:
//   - `commands` below: everything a key, button or menu item can do
//   - ../config.js: key bindings and defaults
//   - styles.css: looks
// From DevTools (Ctrl+Shift+I) the live objects are available as `vp`.

import config from '../config.js';
import { parseNotes, renderNotes, shotNumbersStale } from '../shared/notes.js';
import { ShotList, findCuts } from '../shared/shots.js';
import { Timecode } from '../shared/timecode.js';
import { NoteEditor } from './note-editor.js';
import { Player } from './player.js';
import { Scrubber } from './scrubber.js';
import { Timeline } from './timeline.js';

const api = window.api;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings changed from the UI, remembered between runs.

const settings = {
  scrub: config.scrub.enabledByDefault,
  overlay: config.overlay.visible,
  threshold: config.shots.threshold,
  volume: 1,
  muted: false,
  last: null, // { path, frame } of the most recent video
  ...JSON.parse(localStorage.getItem('settings') ?? '{}'),
};
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(settings));

// ---------------------------------------------------------------------------
// State of the open video.

const video = $('video');
const player = new Player(video, $('still'));
const scrubber = new Scrubber(api, config.scrub);
const editor = new NoteEditor($('note-editor'));

let media = null;                              // info from api.openVideo, null when nothing is open
let tc = new Timecode({ fps: 30 });            // frame <-> timecode for this video
let scene = { times: [], scores: [], complete: false }; // per-frame scene scores from ffmpeg
let shots = new ShotList();                    // shots as frame ranges, derived from `scene`
let notes = { preamble: '', notes: [] };       // parsed notes file
let scrubState = 'none';                       // 'preparing' | 'ready' | 'none' (no audio track)

let resumeAfterDrag = false;
const timeline = new Timeline($('timeline'), {
  onSeek: (time) => player.seekFrame(player.map.frameAt(time)),
  onDragStart: () => {
    resumeAfterDrag = player.playing;
    player.pause();
  },
  onDragEnd: () => {
    if (resumeAfterDrag) player.play();
  },
});

// ---------------------------------------------------------------------------
// Commands. Bound to keys in config.js, to buttons below, and to the menu in main.js.

const commands = {
  'toggle-play': { label: 'Play / pause', run: () => player.toggle() },
  'frame-back': { label: 'Previous frame', repeat: true, run: () => player.step(-1) },
  'frame-forward': { label: 'Next frame', repeat: true, run: () => player.step(1) },
  'second-back': { label: 'Back 1 second', repeat: true, run: () => player.step(-tc.base) },
  'second-forward': { label: 'Forward 1 second', repeat: true, run: () => player.step(tc.base) },
  'prev-shot': { label: 'Previous shot', repeat: true, run: () => gotoShot(-1) },
  'next-shot': { label: 'Next shot', repeat: true, run: () => gotoShot(1) },
  'go-start': { label: 'Go to start', run: () => player.seekFrame(0) },
  'go-end': {
    label: 'Go to end',
    run: () => {
      player.pause();
      player.seekFrame(player.map.count - 1);
    },
  },
  'add-note': { label: 'Add a note at this frame', run: () => addNote() },
  'open-notes': {
    label: 'Open the notes file',
    run: async () => {
      if (!(await api.openNotes())) toast('No notes for this video yet');
    },
  },
  'reveal-notes': { label: 'Show the notes file in its folder', run: () => api.revealNotes() },
  'open-file': {
    label: 'Open a video',
    run: async () => {
      const file = await api.pickVideo();
      if (file) openVideo(file);
    },
  },
  'toggle-scrub': {
    label: 'Audio scrubbing on / off',
    run: () => {
      settings.scrub = !settings.scrub;
      saveSettings();
      renderScrub();
      toast(`Audio scrubbing ${settings.scrub ? 'on' : 'off'}`);
    },
  },
  'toggle-overlay': {
    label: 'Timecode overlay on / off',
    run: () => {
      settings.overlay = !settings.overlay;
      saveSettings();
      renderOverlay();
    },
  },
  'toggle-mute': {
    label: 'Mute',
    run: () => {
      settings.muted = !settings.muted;
      saveSettings();
      renderVolume();
    },
  },
  'toggle-fullscreen': { label: 'Fullscreen', run: () => api.setFullscreen() },
  'exit-fullscreen': { run: () => api.setFullscreen(false) },
};

function run(name) {
  const command = commands[name];
  if (!command) return console.warn(`Unknown command "${name}"`);
  if (editor.isOpen) return; // the note box has the keyboard
  command.run();
}

function gotoShot(direction) {
  if (!media) return;
  const here = player.position;
  let target;
  if (direction > 0) {
    target = shots.nextStart(here);
    if (target === null) return;
  } else {
    // First press returns to the start of this shot, the next one goes a shot
    // back. While playing, the first half second of a shot counts as its start.
    const grace = player.playing ? Math.round(player.map.fps / 2) : 0;
    target = shots.prevStart(Math.max(0, here - grace)) ?? 0;
  }
  player.seekFrame(target);
}

// ---------------------------------------------------------------------------
// Opening a video.

let openTicket = 0;

async function openVideo(file, { frame = 0 } = {}) {
  const ticket = ++openTicket;
  let info;
  try {
    info = await api.openVideo(file);
    if (ticket !== openTicket) return;
    closeVideo();
    await player.load(info.url, info);
  } catch (e) {
    if (ticket === openTicket) toast(`Could not open ${file.split(/[\\/]/).pop()}: ${message(e)}`, true);
    return;
  }
  if (ticket !== openTicket) return;

  media = info;
  tc = Timecode.fromStart(
    config.timecode.useEmbeddedStart ? info.startTimecode : null,
    info.fps,
    config.timecode.dropFrame,
  );
  scrubState = info.hasAudio ? 'preparing' : 'none';
  settings.last = { path: info.path, frame };
  saveSettings();
  document.title = `${info.name} — Video Player`;
  document.body.classList.add('has-video');
  if (frame > 0) player.seekFrame(frame, { silent: true });
  renderAll();

  // Background work. Results are dropped if another video was opened meanwhile.
  const stillOpen = () => media === info;
  const failed = (what) => (e) => {
    if (!stillOpen()) return;
    console.error(e);
    toast(`${what}: ${message(e)}`, true);
  };

  api.frameTimes().then((times) => {
    if (!stillOpen() || !times?.length) return;
    player.setFrameTimes(times);
    renderAll();
    if (scene.complete) syncNotes();
  }).catch(failed('Could not index frames'));

  api.scrubAudio().then((source) => {
    if (!stillOpen()) return;
    scrubber.setSource(source);
    scrubState = source ? 'ready' : 'none';
    renderScrub();
  }).catch(failed('Could not prepare scrub audio'));

  api.scanShots().then(() => {
    if (!stillOpen()) return;
    scene.complete = true;
    updateShots();
    syncNotes();
  }).catch(failed('Shot detection failed'));

  syncNotes();
}

function closeVideo() {
  media = null;
  scene = { times: [], scores: [], complete: false };
  shots = new ShotList([], -1);
  notes = { preamble: '', notes: [] };
  scrubState = 'none';
  scrubber.reset();
  document.title = 'Video Player';
  document.body.classList.remove('has-video');
}

// ---------------------------------------------------------------------------
// Shot detection. ffmpeg scores every frame (in the main process); turning
// scores into cuts happens here so the threshold can be changed instantly.

api.onShotBatch((videoId, times, scores) => {
  if (!media || videoId !== media.id) return;
  for (let i = 0; i < times.length; i++) {
    scene.times.push(times[i]);
    scene.scores.push(scores[i]);
  }
  scheduleShotUpdate();
});

let shotTimer = null;
function scheduleShotUpdate() {
  shotTimer ??= setTimeout(() => {
    shotTimer = null;
    updateShots();
  }, 200);
}

function updateShots() {
  if (!media) return;
  const map = player.map;
  const cutTimes = findCuts(scene.times, scene.scores, { ...config.shots, threshold: settings.threshold });
  // From ffmpeg's timestamps to our frame numbers.
  const cuts = [...new Set(cutTimes.map((time) => map.nearest(time)))].filter((frame) => frame > 0);
  // How far the scan has got: as a media time, and as the last frame covered.
  let scannedTime = Infinity;
  let scannedFrame = Infinity;
  if (!scene.complete) {
    scannedTime = scene.times.at(-1) ?? -Infinity;
    scannedFrame = scene.times.length ? map.nearest(scannedTime) : -1;
  }
  shots = new ShotList(cuts, scannedFrame);
  timeline.setMarks({ cuts: cuts.map((frame) => map.timeOf(frame)), knownUntil: scannedTime });
  renderShots();
  renderFrame();
}

// ---------------------------------------------------------------------------
// Notes. The file is re-read before every change, so edits made in another
// editor are kept. See ../shared/notes.js for the format.

const noteContext = () => ({
  title: media.name,
  frameOf: (stamp) => tc.parse(stamp),
  // A hand-typed timecode outside the video counts as its first / last frame.
  shotOf: (frame) => shots.numberAt(Math.min(Math.max(frame, 0), player.map.count - 1)),
});

async function addNote() {
  if (!media) return toast('Open a video first');
  const wasPlaying = player.playing;
  player.pause();
  const frame = player.position;
  const stamp = tc.format(frame);

  const text = await editor.open(`Shot ${shots.numberAt(frame) ?? '?'} · ${stamp}`);
  if (text) {
    try {
      const doc = parseNotes(await api.readNotes());
      doc.notes.push({ tc: stamp, text });
      await writeNotes(doc);
      toast(`Note saved to ${media.notesName}`);
    } catch (e) {
      toast(`Could not save the note: ${message(e)}`, true);
    }
  }
  if (wasPlaying && config.notes.resumeAfterNote) player.play();
}

async function writeNotes(doc) {
  const markdown = renderNotes(doc, noteContext());
  await api.writeNotes(markdown);
  notes = parseNotes(markdown);
  renderNoteMarks();
}

/** Load the notes file; renumber its shots if detection now says otherwise. */
async function syncNotes() {
  const info = media;
  try {
    const doc = parseNotes(await api.readNotes());
    if (media !== info) return;
    if (scene.complete && doc.notes.length > 0 && shotNumbersStale(doc, noteContext())) {
      await writeNotes(doc);
    } else {
      notes = doc;
      renderNoteMarks();
    }
  } catch (e) {
    if (media === info) toast(`Could not read ${info.notesName}: ${message(e)}`, true);
  }
}

let syncTimer = null;
function scheduleNotesSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNotes, 700);
}

// ---------------------------------------------------------------------------
// Rendering.

function renderAll() {
  if (!media) return;
  const map = player.map;
  timeline.setRange(map.timeOf(0), map.timeOf(map.count - 1));
  $('clock-end').textContent = tc.format(map.count - 1);
  layoutPicture();
  renderOverlay();
  renderScrub();
  renderVolume();
  renderNoteMarks();
  updateShots();
}

function renderFrame() {
  if (!media) return;
  const frame = player.frame;
  const stamp = tc.format(frame);
  $('tc').textContent = stamp;
  $('clock-now').textContent = stamp;

  const details = [];
  if (config.overlay.showShot) details.push(`Shot ${shots.numberAt(frame) ?? '…'}`);
  if (config.overlay.showFrame) details.push(`Frame ${frame}`);
  $('tc-sub').textContent = details.join(' · ');

  timeline.setPosition(player.map.timeOf(player.position));
  if (settings.last) settings.last.frame = frame;
}

function renderShots() {
  let text = media ? `Shots ${shots.count}` : 'Shots —';
  if (media && !scene.complete) {
    const map = player.map;
    const span = map.timeOf(map.count - 1) - map.timeOf(0);
    const done = scene.times.length ? (scene.times.at(-1) - map.timeOf(0)) / (span || 1) : 0;
    text += ` · scanning ${Math.round(Math.min(1, Math.max(0, done)) * 100)}%`;
  }
  $('shots-label').textContent = text;
  $('threshold').value = settings.threshold;
  $('threshold-value').textContent = Number(settings.threshold).toFixed(2);
}

function renderNoteMarks() {
  if (!media) return;
  const times = notes.notes
    .map((note) => tc.parse(note.tc))
    .filter((frame) => frame !== null)
    .map((frame) => player.map.timeOf(frame));
  timeline.setMarks({ notes: times });
}

function renderOverlay() {
  const overlay = $('overlay');
  overlay.className = `overlay ${config.overlay.position}`;
  overlay.hidden = !settings.overlay;
}

function renderScrub() {
  const button = $('scrub');
  scrubber.enabled = settings.scrub;
  button.setAttribute('aria-pressed', String(settings.scrub && scrubState !== 'none'));
  button.disabled = Boolean(media) && scrubState === 'none';
  button.title = {
    none: media ? 'This video has no audio track' : 'Play audio while stepping or dragging',
    preparing: 'Preparing the audio for scrubbing…',
    ready: 'Play audio while stepping or dragging',
  }[scrubState];
}

function renderVolume() {
  video.volume = settings.volume;
  video.muted = settings.muted;
  scrubber.volume = settings.muted ? 0 : settings.volume;
  $('volume').value = settings.volume;
  $('mute').classList.toggle('muted', settings.muted || settings.volume === 0);
}

function renderPlayState() {
  $('play').classList.toggle('playing', player.playing);
}

/** Size #picture to the visible picture, so the overlay sits on the image, not the letterbox. */
function layoutPicture() {
  const stage = $('stage');
  const { clientWidth: width, clientHeight: height } = stage;
  const scale = Math.min(width / (video.videoWidth || width), height / (video.videoHeight || height));
  const w = (video.videoWidth || width) * scale;
  const h = (video.videoHeight || height) * scale;
  Object.assign($('picture').style, {
    left: `${(width - w) / 2}px`,
    top: `${(height - h) / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
}

let toastTimer = null;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 1800);
}

function message(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------------------
// Events.

player.addEventListener('frame', renderFrame);
player.addEventListener('state', () => {
  renderPlayState();
  if (!player.playing) saveSettings(); // remembers the position
});
player.addEventListener('seek', ({ detail }) => {
  timeline.setPosition(detail.time);
  if (!player.playing) scrubber.play(detail.time, player.map.durationOf(detail.frame));
});

// Keyboard: config.keys maps "Ctrl+N"-style names to commands.
function keyName(e) {
  const named = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
  const key = named[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + key;
}

window.addEventListener('keydown', (e) => {
  if (editor.isOpen) return;
  const name = config.keys[keyName(e)];
  if (!commands[name]) return;
  e.preventDefault();
  if (e.repeat && !commands[name].repeat) return;
  run(name);
}, true);

api.onCommand(run); // from the menu

// Buttons and sliders. They never take keyboard focus, so Space and the arrow
// keys always go to the player.
$('controls').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});
for (const range of document.querySelectorAll('input[type=range]')) {
  range.addEventListener('change', () => range.blur());
}
$('play').addEventListener('click', () => run('toggle-play'));
$('scrub').addEventListener('click', () => run('toggle-scrub'));
$('mute').addEventListener('click', () => run('toggle-mute'));
$('open').addEventListener('click', () => run('open-file'));
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  settings.muted = false;
  saveSettings();
  renderVolume();
});
$('threshold').addEventListener('input', (e) => {
  settings.threshold = Number(e.target.value);
  saveSettings();
  updateShots();
  scheduleNotesSync(); // shot numbers in the notes follow the new cuts
});
video.addEventListener('click', () => run('toggle-play'));
video.addEventListener('dblclick', () => run('toggle-fullscreen'));

// Drag a file onto the window to open it.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  const path = file && api.pathForFile(file);
  if (path) openVideo(path);
});

new ResizeObserver(layoutPicture).observe($('stage'));
window.addEventListener('beforeunload', saveSettings);

// ---------------------------------------------------------------------------
// Start-up.

// Shortcut list on the welcome screen, straight from config.keys.
$('shortcuts').append(...Object.entries(config.keys).flatMap(([key, name]) => {
  if (!commands[name]?.label) return [];
  const dt = document.createElement('dt');
  dt.append(...key.split('+').flatMap((part, i) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    return i ? ['+', kbd] : [kbd];
  }));
  const dd = document.createElement('dd');
  dd.textContent = commands[name].label;
  return [dt, dd];
}));

renderOverlay();
renderScrub();
renderVolume();
renderShots();

window.vp = {
  config, settings, commands, player, scrubber, timeline, run, openVideo,
  get media() { return media; },
  get timecode() { return tc; },
  get scene() { return scene; },
  get shots() { return shots; },
  get notes() { return notes; },
};

const initial = await api.initialFile();
if (initial) openVideo(initial);
else if (config.reopenLast && settings.last?.path) openVideo(settings.last.path, { frame: settings.last.frame });
