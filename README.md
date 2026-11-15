# Video Player

A small, hackable desktop video player for looking closely at footage:
timecode overlay, frame-by-frame and shot-by-shot stepping, audio scrubbing,
and timecoded notes saved to a markdown file next to the video.

Built with Electron (the UI is plain HTML/CSS/JS, no build step) and ffmpeg.

## Run

Requires [Node.js](https://nodejs.org) and `ffmpeg` / `ffprobe` on `PATH`.

```
npm install
npm start                          # then Ctrl+O, or drop a file on the window
npm start -- "D:\clips\take 3.mp4"
```

On Windows you can also double-click `Video Player.cmd`, or drop a video onto it.

### Opening videos from Explorer (Windows)

```
npm run register                                # .mp4
npm run register -- -Extensions .mp4,.mov,.mkv  # more types
npm run unregister                              # undo
```

This adds Video Player to **Open with** for those file types (for your user
account only; nothing needs admin rights) and opens Windows' *Default apps*
page for it. Windows does not let a program make itself the default, so choose
it there once: click the file type, pick **Video Player**, **Set default**.
The registration points at this folder, so run it again if you move the project.

Plays whatever Chromium can decode: MP4/MOV/MKV with H.264 (and HEVC where
the GPU supports it), WebM with VP9/AV1.

## Keys

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Previous / next frame |
| `Shift`+`←` `→` | Back / forward one second |
| `↑` `↓` | Previous / next shot (`↑` first returns to the start of the current shot) |
| `Home` `End` | First / last frame |
| `Ctrl`+`N` | Add a note at the current frame |
| `S` | Audio scrubbing on / off (also the **Scrub audio** button) |
| `T` | Timecode overlay on / off |
| `M` | Mute |
| `F` | Fullscreen (`Esc` leaves) |
| `Ctrl`+`O` | Open a video |

Click the picture to play/pause, drag the timeline to seek. All bindings live in
[`config.js`](config.js).

## How the features work

**Timecode** is `HH:MM:SS:FF`, counted in frames from the start of the file. If
the file has an embedded start timecode (e.g. camera originals starting at
`01:00:00:00`) it is used, including drop-frame (`;`) at 29.97/59.94. The
overlay also shows the shot number and absolute frame number.

**Frame stepping** uses the real presentation timestamp of every frame (read
with ffprobe when a file is opened), so variable-frame-rate recordings and
trimmed clips step correctly too.

**Shot detection** runs in the background when a video is first opened: ffmpeg
scores how much each frame differs from the one before, and a frame starts a
new shot when its score reaches the threshold — or is clearly above its
neighbours, which catches quieter cuts. Shots appear on the timeline as ticks
while the scan progresses. The slider in the control bar changes the threshold
instantly, without rescanning. Hard cuts are detected; dissolves and fades are not.

**Audio scrubbing** plays a short snippet of sound at each frame you step or
drag to while paused. It uses a mono copy of the soundtrack that is extracted
once per video.

**Notes** — `Ctrl+N` opens a text box (Enter saves, Shift+Enter adds a line, Esc
cancels). Notes for `clip.mp4` go to `clip.md` in the same folder:

```markdown
# Notes — clip.mp4

## Shot 3

### Shot 3 · 00:00:12:18

Boom dips into frame.

### Shot 3 · 00:00:14:02

Cut feels a few frames late.

## Shot 7

### Shot 7 · 00:00:33:09

...
```

Notes are kept in timecode order and grouped by shot. You can edit the file by
hand: anything above the first note is preserved, note bodies are free-form
markdown, and a note added as just `### 00:00:20:00` is filed under the right
shot the next time the app writes the file. Shot numbers are derived from the
timecodes, so they are updated if you change the shot threshold.

Frame timestamps, shot scores and scrub audio are cached per video under
`%APPDATA%\video-player\media-cache` (about 230 MB per hour of video, almost
all of it scrub audio) and removed after 30 days without use.

## Customizing

Edit, then press `Ctrl+R` in the app to reload. `Ctrl+Shift+I` opens DevTools,
where the live objects are available as `vp` (`vp.player`, `vp.shots`, …).

| File | What it holds |
| --- | --- |
| `config.js` | Key bindings, overlay position, scrub snippet length, shot-detection tuning, notes file suffix |
| `renderer/app.js` | Wiring. The `commands` table is everything a key, button or menu item can do — add a command there, bind it in `config.js` |
| `renderer/styles.css` | Looks; colours are CSS variables at the top |
| `renderer/index.html` | Layout of the window |
| `renderer/player.js` | Frame-accurate seeking and stepping on the `<video>` element |
| `renderer/scrubber.js` | Audio scrubbing |
| `renderer/timeline.js` | Seek bar with shot ticks and note markers |
| `renderer/note-editor.js` | The `Ctrl+N` text box |
| `shared/timecode.js` | Frame ↔ timecode, including drop-frame |
| `shared/frame-map.js` | Media time ↔ frame index |
| `shared/shots.js` | Scene scores → cuts; shot lookup and navigation |
| `shared/notes.js` | Notes file format: parse and render |
| `main.js`, `main/` | Electron main process: window, menu, file access, ffmpeg jobs and their cache |
| `preload.cjs` | The `window.api` bridge between the UI and `main.js` |
| `tools/file-association.ps1` | Registers the app with Windows for "Open with" / default app |

To give the UI a new capability that needs the file system or ffmpeg, handle a
new channel in `main.js` and expose it in `preload.cjs`.

## Tests

```
npm test            # unit tests for shared/ (fast, no window)
npm run test:e2e    # launches the app and drives it with the keyboard (~30 s)
```

The end-to-end test generates small videos whose frames carry their own frame
number as a row of black/white squares, and checks what is actually on screen
after each step.
