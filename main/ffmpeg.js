// ffprobe / ffmpeg jobs: probe a file, read its frame timestamps, score every
// frame for shot detection, extract the audio-scrub track.

import { spawn } from 'node:child_process';
import os from 'node:os';
import config from '../config.js';

const { ffmpegPath, ffprobePath } = config.ffmpeg;

/**
 * Run a command, streaming stdout to `onStdout` (or collecting it).
 * Rejects on non-zero exit, on spawn failure, or when `signal` aborts.
 */
function run(cmd, args, { signal, onStdout, lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout ?? ((chunk) => out.push(chunk)));
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); });
    child.on('spawn', () => {
      if (!lowPriority) return;
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    });
    child.on('error', (e) => {
      reject(e.code === 'ENOENT'
        ? new Error(`"${cmd}" was not found. Install ffmpeg and make sure it is on PATH (or set ffmpeg paths in config.js).`)
        : e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out.join(''));
      else reject(new Error(`${cmd} exited with code ${code}: ${err.trim()}`));
    });
  });
}

/** Calls `onLine` for each complete line of a chunked text stream. */
function lineSplitter(onLine) {
  let carry = '';
  return (chunk) => {
    const lines = (carry + chunk).split('\n');
    carry = lines.pop();
    for (const line of lines) onLine(line);
  };
}

function parseRate(rate) {
  const [num, den] = String(rate ?? '').split('/').map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** Basic facts about the first video stream. */
export async function probe(file, signal) {
  const json = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { signal });
  const { streams = [], format = {} } = JSON.parse(json);
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('No video stream found in this file.');

  const startTime = Number(video.start_time) || 0;
  return {
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30,
    startTime,
    // Media time at which the video ends (some containers only know the file's total length).
    duration: Number(video.duration) ? startTime + Number(video.duration) : Number(format.duration) || 0,
    frameCount: Number(video.nb_frames) || 0,
    width: video.width,
    height: video.height,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    // Embedded start timecode: on the video stream, a tmcd data stream, or the container.
    startTimecode: video.tags?.timecode
      ?? streams.find((s) => s.tags?.timecode)?.tags.timecode
      ?? format.tags?.timecode
      ?? null,
  };
}

/** Presentation time of every video frame, ascending. Reads packets only (no decoding). */
export async function readFrameTimes(file, signal) {
  const times = [];
  await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file,
  ], {
    signal,
    onStdout: lineSplitter((line) => {
      const [pts, flags = ''] = line.trim().split(',');
      const t = Number.parseFloat(pts);
      // 'D' marks packets the player discards (e.g. trimmed by an edit list).
      if (Number.isFinite(t) && !flags.includes('D')) times.push(t);
    }),
  });
  return Float64Array.from(times).sort();
}

/**
 * Decode the whole video and report ffmpeg's scene score for every frame.
 * `onBatch(times, scores)` is called a few times per second as results arrive.
 */
export async function scanSceneScores(file, { signal, onBatch }) {
  const width = config.shots.analysisWidth;
  let times = [];
  let scores = [];
  let pendingTime = null;
  let lastFlush = Date.now();
  const flush = () => {
    if (times.length) onBatch(Float64Array.from(times), Float32Array.from(scores));
    times = [];
    scores = [];
    lastFlush = Date.now();
  };

  await run(ffmpegPath, [
    // -copyts: keep the file's own timestamps (ffmpeg otherwise shifts them so
    // the earliest stream starts at 0, which would disagree with ffprobe).
    '-hide_banner', '-v', 'error', '-nostats', '-copyts',
    '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
    // settb=AVTB puts timestamps in microseconds, so the integer "pts:" field is
    // exact ("pts_time:" is printed with only 6 significant digits).
    '-vf', `settb=AVTB,scale=w='min(${width},iw)':h=-2:flags=fast_bilinear,select='gte(scene,0)',metadata=print:file=-`,
    '-f', 'null', '-',
  ], {
    signal,
    lowPriority: true,
    // Output alternates:  "frame:12 pts:500000 pts_time:0.5"  /  "lavfi.scene_score=0.012345"
    onStdout: lineSplitter((line) => {
      const t = /\bpts:\s*(-?\d+)/.exec(line);
      if (t) {
        pendingTime = Number(t[1]) / 1e6;
        return;
      }
      const s = /scene_score=([\d.]+)/.exec(line);
      if (s && pendingTime !== null) {
        times.push(pendingTime);
        scores.push(Number(s[1]));
        pendingTime = null;
        if (Date.now() - lastFlush > 250) flush();
      }
    }),
  });
  flush();
}

/**
 * Write the first audio stream as raw mono 16-bit PCM, aligned so that sample 0
 * is media time 0 (leading silence is added or early audio trimmed as needed).
 */
export async function extractScrubAudio(file, outFile, { sampleRate, signal }) {
  await run(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-nostats', '-y', '-copyts',
    '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `aresample=${sampleRate}:async=1:first_pts=0`,
    '-ac', '1', '-f', 's16le', outFile,
  ], { signal, lowPriority: true });
}
