// Central configuration — imported by both the main process and the renderer.
// Edit and press Ctrl+R in the app to reload (changes under `ffmpeg`, `cache`
// and `notes.fileSuffix` are read by the main process and need an app restart).

export default {
  // ffmpeg / ffprobe executables. Bare names are resolved through PATH.
  ffmpeg: {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  },

  // Reopen the last video (at the last position) when the app starts.
  reopenLast: true,

  overlay: {
    visible: true,
    // top-left | top-center | top-right | bottom-left | bottom-center | bottom-right
    position: 'top-left',
    showShot: true,   // "Shot 12" under the timecode
    showFrame: true,  // absolute frame number under the timecode
  },

  timecode: {
    // Start counting from the file's embedded timecode track, if it has one.
    useEmbeddedStart: true,
    // 'auto' = drop-frame only when the embedded timecode says so (HH:MM:SS;FF).
    // true / false force it (only meaningful at 29.97 and 59.94 fps).
    dropFrame: 'auto',
  },

  scrub: {
    enabledByDefault: true,
    snippetFrames: 2,   // length of audio played per step, in frames...
    minSnippetMs: 70,   // ...but never shorter than this
    fadeMs: 6,          // fade in/out to avoid clicks
    minGapMs: 30,       // rate limit while dragging the timeline
    sampleRate: 32000,  // mono scrub track cached on disk (~230 MB per hour)
  },

  shots: {
    // A frame starts a new shot when ffmpeg's scene score reaches `threshold`.
    // This is the initial value: once you move the slider in the control bar,
    // the slider's setting is remembered instead.
    threshold: 0.3,
    // Quieter cuts (dark scenes, similar framing) still count when the score is
    // at least threshold * adaptiveFloor AND stands out from the frames within
    // minShotSec by a factor of adaptiveRatio (one of them may reach half the
    // score). Set adaptiveRatio to 0 to disable. Raising the floor ignores more
    // jumps inside a shot (generated or lip-synced footage often has them).
    adaptiveFloor: 0.5,
    adaptiveRatio: 6,
    // Two cuts closer than this are merged (flashes, strobing).
    minShotSec: 0.25,
    // Width frames are scaled to before scoring. Smaller is faster.
    analysisWidth: 320,
  },

  notes: {
    // Notes live next to the video: clip.mp4 -> clip.md
    fileSuffix: '.md',
    // Resume playback after saving/cancelling a note if it was playing.
    resumeAfterNote: true,
  },

  cache: {
    // Frame index, shot scores and scrub audio are cached per video under
    // %APPDATA%/video-player/media-cache and dropped when unused this long.
    maxAgeDays: 30,
  },

  // Key -> command. Key names: optional Ctrl+ / Alt+ / Shift+ prefixes (in that
  // order) followed by Space, Left, Right, Up, Down, Home, End, Enter, or a
  // single upper-case letter / digit. Commands are defined in renderer/app.js.
  keys: {
    'Space': 'toggle-play',
    'Left': 'frame-back',
    'Right': 'frame-forward',
    'Shift+Left': 'second-back',
    'Shift+Right': 'second-forward',
    'Up': 'prev-shot',
    'Down': 'next-shot',
    'Home': 'go-start',
    'End': 'go-end',
    'Ctrl+N': 'add-note',
    'Ctrl+O': 'open-file',
    'S': 'toggle-scrub',
    'T': 'toggle-overlay',
    'M': 'toggle-mute',
    'F': 'toggle-fullscreen',
    'Escape': 'exit-fullscreen',
  },
};
