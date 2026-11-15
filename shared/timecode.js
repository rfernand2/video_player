// SMPTE timecode <-> frame index. Pure module (used by the renderer and tests).

const TC_RE = /(\d{2,}):(\d{2}):(\d{2})([:;])(\d{2,3})/;

/** Matches a timecode anywhere in a string. Groups: hh, mm, ss, separator, ff. */
export const TIMECODE_PATTERN = TC_RE;

export class Timecode {
  /**
   * @param {object} o
   * @param {number} o.fps         real frame rate, e.g. 23.976
   * @param {boolean} [o.dropFrame] drop-frame counting (29.97 / 59.94 only)
   * @param {number} [o.startFrame] timecode frame count of the video's first frame
   */
  constructor({ fps, dropFrame = false, startFrame = 0 }) {
    this.fps = fps;
    this.base = Math.max(1, Math.round(fps));
    this.dropFrame = Boolean(dropFrame) && Timecode.supportsDropFrame(fps);
    this.startFrame = startFrame;
  }

  static supportsDropFrame(fps) {
    const base = Math.round(fps);
    return (base === 30 || base === 60) && Math.abs(fps - base) > 0.005;
  }

  /**
   * Build from a file's embedded start timecode ("01:00:00:00" or "01:00:00;00").
   * `dropFrame` overrides the separator's hint when it is a boolean.
   */
  static fromStart(start, fps, dropFrame = 'auto') {
    const m = start ? TC_RE.exec(start) : null;
    const df = typeof dropFrame === 'boolean' ? dropFrame : Boolean(m && m[4] === ';');
    const tc = new Timecode({ fps, dropFrame: df });
    if (m) tc.startFrame = tc.#count(+m[1], +m[2], +m[3], +m[5]);
    return tc;
  }

  /** Frame index (0 = first frame of the video) -> "HH:MM:SS:FF". */
  format(frame) {
    let n = Math.max(0, Math.round(frame) + this.startFrame);
    const b = this.base;
    if (this.dropFrame) {
      // Re-insert the frame numbers drop-frame counting skips: 2 (or 4 at
      // 59.94) at the start of every minute except each tenth minute.
      const drop = b / 15;
      const per10Min = b * 600 - drop * 9;
      const perMin = b * 60 - drop;
      const tens = Math.floor(n / per10Min);
      const rest = n % per10Min;
      n += drop * 9 * tens;
      if (rest > drop) n += drop * Math.floor((rest - drop) / perMin);
    }
    const ff = n % b;
    const s = Math.floor(n / b);
    const pad = (v, w = 2) => String(v).padStart(w, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` +
      `${this.dropFrame ? ';' : ':'}${pad(ff, b > 100 ? 3 : 2)}`;
  }

  /** "HH:MM:SS:FF" -> frame index of the video, or null if it isn't a timecode. */
  parse(str) {
    const m = TC_RE.exec(str ?? '');
    if (!m) return null;
    return this.#count(+m[1], +m[2], +m[3], +m[5]) - this.startFrame;
  }

  #count(h, m, s, f) {
    const b = this.base;
    let n = ((h * 60 + m) * 60 + s) * b + f;
    if (this.dropFrame) {
      const minutes = h * 60 + m;
      n -= (b / 15) * (minutes - Math.floor(minutes / 10));
    }
    return n;
  }
}
