// Electron main process: window, menu, file access and ffmpeg jobs.
// The renderer (renderer/app.js) talks to this through preload.cjs.

import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from './config.js';
import { cacheDirFor, pruneCache, readTypedArray, writeTypedArray } from './main/cache.js';
import { extractScrubAudio, probe, readFrameTimes, scanSceneScores } from './main/ffmpeg.js';

const ROOT = import.meta.dirname;
const cacheRoot = () => path.join(app.getPath('userData'), 'media-cache');

let win = null;

// ---------------------------------------------------------------------------
// The open video. Opening another one aborts the previous one's ffmpeg jobs.

let session = null;
let sessionCount = 0;

async function openVideo(file) {
  closeSession();
  file = path.resolve(file);
  const id = ++sessionCount;
  const abort = new AbortController();
  const info = await probe(file, abort.signal);
  const cacheDir = await cacheDirFor(cacheRoot(), file);
  if (id !== sessionCount) throw new Error('Superseded by another open request.');

  const { dir, name } = path.parse(file);
  const notesPath = path.join(dir, name + config.notes.fileSuffix);
  session = { id, file, abort, info, cacheDir, notesPath, jobs: {}, audio: null };
  return {
    id,
    path: file,
    name: path.basename(file),
    url: pathToFileURL(file).href,
    notesName: path.basename(notesPath),
    ...info,
  };
}

function closeSession() {
  if (!session) return;
  session.abort.abort();
  session.audio?.close().catch(() => {});
  session = null;
}

/** Run `fn(session)` at most once per open video; later calls share the result. */
function job(name, fn) {
  const s = session;
  if (!s) return null;
  return (s.jobs[name] ??= fn(s));
}

function concat(Type, chunks) {
  const out = new Type(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC: media

ipcMain.handle('media:open', (_e, file) => openVideo(file));

// Exact presentation time of every frame (Float64Array).
ipcMain.handle('media:frame-times', () => job('frames', async (s) => {
  const file = path.join(s.cacheDir, 'frame-times.f64');
  if (existsSync(file)) return readTypedArray(file, Float64Array);
  const times = await readFrameTimes(s.file, s.abort.signal);
  await writeTypedArray(file, times);
  return times;
}));

// Scene score of every frame, streamed to the renderer as 'shots:batch'
// events while ffmpeg works through the file. Resolves when complete.
ipcMain.handle('media:scan-shots', (event) => job('shots', async (s) => {
  const send = (times, scores) => {
    if (!event.sender.isDestroyed()) event.sender.send('shots:batch', s.id, times, scores);
  };
  const timesFile = path.join(s.cacheDir, 'scene-times.f64');
  const scoresFile = path.join(s.cacheDir, 'scene-scores.f32');
  if (existsSync(timesFile) && existsSync(scoresFile)) {
    send(await readTypedArray(timesFile, Float64Array), await readTypedArray(scoresFile, Float32Array));
    return;
  }
  const times = [];
  const scores = [];
  await scanSceneScores(s.file, {
    signal: s.abort.signal,
    onBatch: (t, sc) => {
      times.push(t);
      scores.push(sc);
      send(t, sc);
    },
  });
  await writeTypedArray(scoresFile, concat(Float32Array, scores));
  await writeTypedArray(timesFile, concat(Float64Array, times));
}));

// Mono 16-bit PCM copy of the audio, read in small pieces while scrubbing.
ipcMain.handle('media:scrub-audio', () => job('audio', async (s) => {
  if (!s.info.hasAudio) return null;
  const sampleRate = config.scrub.sampleRate;
  const file = path.join(s.cacheDir, `scrub-${sampleRate}.pcm`);
  if (!existsSync(file)) {
    await extractScrubAudio(s.file, `${file}.part`, { sampleRate, signal: s.abort.signal });
    await fs.rename(`${file}.part`, file);
  }
  const handle = await fs.open(file, 'r');
  if (s.abort.signal.aborted) {
    await handle.close();
    throw new Error('Superseded by another open request.');
  }
  s.audio = handle;
  return { sampleRate, sampleCount: Math.floor((await handle.stat()).size / 2) };
}));

ipcMain.handle('media:read-audio', async (_e, start, count) => {
  const audio = session?.audio;
  if (!audio) return null;
  start = Math.max(0, Math.floor(start));
  count = Math.min(Math.max(0, Math.floor(count)), config.scrub.sampleRate * 5);
  const buf = Buffer.alloc(count * 2);
  const { bytesRead } = await audio.read(buf, 0, buf.length, start * 2);
  return new Int16Array(buf.buffer, buf.byteOffset, bytesRead >> 1);
});

// ---------------------------------------------------------------------------
// IPC: notes file (always the one belonging to the open video)

ipcMain.handle('notes:read', async () => {
  if (!session) return null;
  try {
    return await fs.readFile(session.notesPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
});

ipcMain.handle('notes:write', async (_e, text) => {
  if (!session) throw new Error('No video is open.');
  await fs.writeFile(session.notesPath, text, 'utf8');
});

ipcMain.handle('notes:open', async () => {
  if (!session || !existsSync(session.notesPath)) return false;
  return (await shell.openPath(session.notesPath)) === '';
});

ipcMain.handle('notes:reveal', () => {
  if (!session) return false;
  shell.showItemInFolder(existsSync(session.notesPath) ? session.notesPath : session.file);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: app

ipcMain.handle('app:pick-video', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// A video passed on the command line:  npm start -- "D:\clips\take 3.mp4"
ipcMain.handle('app:initial-file', () => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const file = args.find((arg) => !arg.startsWith('-') && statSync(arg, { throwIfNoEntry: false })?.isFile());
  return file ? path.resolve(file) : null;
});

ipcMain.handle('app:set-fullscreen', (_e, on) => {
  if (!win) return;
  win.setFullScreen(on ?? !win.isFullScreen());
});

// ---------------------------------------------------------------------------
// Window and menu

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#0f0f11',
    title: 'Video Player',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs') },
  });
  win.on('enter-full-screen', () => win.setMenuBarVisibility(false));
  win.on('leave-full-screen', () => win.setMenuBarVisibility(true));
  win.on('closed', () => { win = null; });
  // This window only ever shows the app itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
}

function buildMenu() {
  // Shortcuts are handled by the renderer (config.js `keys`); the menu only
  // displays them, so they never fire while typing a note.
  const keyFor = Object.fromEntries(Object.entries(config.keys).map(([key, command]) => [command, key]));
  const item = (label, command) => ({
    label,
    accelerator: keyFor[command],
    registerAccelerator: false,
    click: () => win?.webContents.send('command', command),
  });
  return Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        item('Open Video…', 'open-file'),
        { type: 'separator' },
        item('Add Note', 'add-note'),
        item('Open Notes File', 'open-notes'),
        item('Show Notes in Folder', 'reveal-notes'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Playback',
      submenu: [
        item('Play / Pause', 'toggle-play'),
        { type: 'separator' },
        item('Next Frame', 'frame-forward'),
        item('Previous Frame', 'frame-back'),
        item('Forward 1 Second', 'second-forward'),
        item('Back 1 Second', 'second-back'),
        { type: 'separator' },
        item('Next Shot', 'next-shot'),
        item('Previous Shot', 'prev-shot'),
        { type: 'separator' },
        item('Go to Start', 'go-start'),
        item('Go to End', 'go-end'),
        { type: 'separator' },
        item('Toggle Audio Scrubbing', 'toggle-scrub'),
        item('Toggle Mute', 'toggle-mute'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Toggle Timecode Overlay', 'toggle-overlay'),
        item('Toggle Fullscreen', 'toggle-fullscreen'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ]);
}

nativeTheme.themeSource = 'dark';

app.whenReady().then(() => {
  pruneCache(cacheRoot(), config.cache.maxAgeDays);
  Menu.setApplicationMenu(buildMenu());
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', closeSession); // stops any ffmpeg job still running
