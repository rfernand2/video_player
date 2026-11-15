// Generates the test videos (once) with ffmpeg. Every frame carries its own
// frame number as a row of 12 black/white squares along the bottom edge, so a
// test can read from the screen exactly which frame is being shown.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const MEDIA_DIR = path.join(import.meta.dirname, 'media');
export const SIZE = { width: 640, height: 360 };
export const BITS = 12;
export const BOX = { pitch: 24, size: 20, y: 338 }; // bit k occupies x = k*pitch+2 .. +size

const counter = [
  `drawbox=x=0:y=${SIZE.height - 24}:w=${SIZE.width}:h=24:color=black:t=fill`,
  ...Array.from({ length: BITS }, (_, k) =>
    `drawbox=x=${k * BOX.pitch + 2}:y=${BOX.y}:w=${BOX.size}:h=${BOX.size}:color=white:t=fill:` +
    `enable='eq(mod(floor(n/${2 ** k}),2),1)'`),
].join(',');

const src = (name, opts) => `${name}=s=${SIZE.width}x${SIZE.height}:${opts},format=yuv420p,setsar=1`;
const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-bf', '2'];

export const videos = {
  // 24 fps, six shots, with sound. The last cut (dark grey to slightly lighter
  // grey) is deliberately subtle: it scores well below the default threshold
  // and is only found because it stands out from the frames around it.
  shots: {
    frames: 240,
    cuts: [48, 84, 144, 168, 204], // first frame of shots 2..6
    subtleCut: 204,
    args: [
      '-filter_complex', [
        `${src('testsrc2', 'r=24:d=2')}[a]`,
        `${src('smptebars', 'r=24:d=1.5')}[b]`,
        `${src('gradients', 'r=24:d=2.5')}[c]`,
        `${src('rgbtestsrc', 'r=24:d=1')}[d]`,
        `${src('color', 'c=0x404040:r=24:d=1.5')}[e]`,
        `${src('color', 'c=0x545454:r=24:d=1.5')}[f]`,
        `[a][b][c][d][e][f]concat=n=6:v=1:a=0,${counter}[v]`,
        `aevalsrc='0.4*sin(2*PI*(220+60*t)*t)':d=10:s=48000[au]`,
      ].join(';'),
      '-map', '[v]', '-map', '[au]', ...x264, '-g', '48', '-c:a', 'aac',
    ],
  },
  // Variable frame rate: a 30 fps source with every 4th frame removed. No audio.
  vfr: {
    frames: 90,
    sourceFrame: (i) => i + Math.floor((i + 1) / 3), // number painted on frame i: 0,1,3,4,5,7,8,9,11,...
    args: [
      '-filter_complex', `${src('testsrc2', 'r=30:d=4')},${counter},select='not(eq(mod(n,4),2))'[v]`,
      '-map', '[v]', '-fps_mode', 'vfr', ...x264,
    ],
  },
  // 29.97 fps with an embedded drop-frame start timecode of 01:00:00;00.
  timecode: {
    args: [
      '-filter_complex', `${src('testsrc2', 'r=30000/1001:d=3')},${counter}[v]`,
      '-map', '[v]', ...x264, '-timecode', '01:00:00;00',
    ],
  },
};

// File names include a hash of the recipe, so changing a recipe regenerates the video.
for (const [name, video] of Object.entries(videos)) {
  const hash = createHash('sha1').update(video.args.join(' ')).digest('hex').slice(0, 8);
  video.file = path.join(MEDIA_DIR, `${name}-${hash}.mp4`);
}

export function ensureMedia() {
  mkdirSync(MEDIA_DIR, { recursive: true });
  for (const { file, args } of Object.values(videos)) {
    if (existsSync(file)) continue;
    const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args, file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ffmpeg failed for ${file}:\n${result.stderr || result.error}`);
  }
}

if (process.argv[1] === import.meta.filename) ensureMedia();
