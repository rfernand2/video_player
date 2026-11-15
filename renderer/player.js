// Frame-accurate control of a <video> element.
//
// Events (on the Player):
//   'frame'  the frame on screen changed            -> read player.frame
//   'state'  play / pause / ended
//   'seek'   a seek was requested while paused or playing
//            detail: { frame, time }  (used for audio scrubbing)

import { FrameMap } from '../shared/frame-map.js';

export class Player extends EventTarget {
  /**
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} still laid exactly over the video; shows the
   *   current frame while paused. Chromium sometimes fails to repaint a paused
   *   <video> when seeks follow each other quickly (the picture stays on an
   *   earlier frame for a second or more), so paused frames are drawn here.
   */
  constructor(video, still) {
    super();
    this.video = video;
    this.still = still;
    this.map = new FrameMap({ fps: 30 });
    this.frame = 0;        // frame currently on screen
    this.mediaTime = 0;    // its presentation time, as reported by the browser
    this.loaded = false;
    this._target = null;   // frame last asked for while paused (the screen may lag behind it)
    this._queued = null;   // seek time waiting for the in-flight seek to finish

    for (const type of ['play', 'pause', 'ended']) {
      video.addEventListener(type, () => this.dispatchEvent(new Event('state')));
    }
    // Otherwise a seek after the end (e.g. stepping back) would resume playback.
    video.addEventListener('ended', () => video.pause());
    video.addEventListener('seeked', () => {
      if (this._queued === null) return this._drawStill();
      const t = this._queued;
      this._queued = null;
      video.currentTime = t;
    });

    this._watchFrames();
  }

  /** (Re)start listening for presented frames; each comes with its exact timestamp. */
  _watchFrames() {
    const { video } = this;
    if (this._frameCallback) video.cancelVideoFrameCallback(this._frameCallback);
    const onFrame = (_now, meta) => {
      this._present(meta.mediaTime);
      this._drawStill();
      this._onFirstFrame?.();
      this._frameCallback = video.requestVideoFrameCallback(onFrame);
    };
    this._frameCallback = video.requestVideoFrameCallback(onFrame);
  }

  /** Paused: copy the current frame onto the canvas. Playing: get out of the way. */
  _drawStill() {
    const { video, still } = this;
    if (!this.loaded || !video.paused) {
      still.hidden = true;
      return;
    }
    if (still.width !== video.videoWidth || still.height !== video.videoHeight) {
      still.width = video.videoWidth;
      still.height = video.videoHeight;
    }
    still.getContext('2d', { alpha: false }).drawImage(video, 0, 0, still.width, still.height);
    still.hidden = false;
  }

  /** @param {string} url  @param {object} info from api.openVideo */
  async load(url, info) {
    const v = this.video;
    this.loaded = false;
    this.still.hidden = true;
    this.map = new FrameMap(info);
    this.frame = 0;
    this.mediaTime = 0;
    this._target = null;
    this._queued = null;
    v.pause();
    v.src = url;
    this._watchFrames(); // drops any callback still pending for the previous video
    // The first frame presented tells us where the video really starts.
    const firstFrame = new Promise((resolve) => {
      this._onFirstFrame = () => {
        this._onFirstFrame = null;
        resolve(true);
      };
      setTimeout(resolve, 1000, false); // e.g. the window is minimized: nothing gets presented
    });
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        v.removeEventListener('loadeddata', onLoad);
        v.removeEventListener('error', onError);
      };
      const onLoad = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        reject(new Error(v.error?.message || 'This video format is not supported.'));
      };
      v.addEventListener('loadeddata', onLoad);
      v.addEventListener('error', onError);
    });
    if (await firstFrame) this.map.calibrate(this.mediaTime);
    this.loaded = true;
    this._present(this.mediaTime);
    this._drawStill();
  }

  /** Switch from the constant-frame-rate estimate to real frame timestamps. */
  setFrameTimes(times) {
    const targetTime = this._target === null ? null : this.map.seekTime(this._target);
    this.map.setTimes(times);
    if (targetTime !== null) this._target = this.map.frameAt(targetTime); // frame numbers may have shifted
    this._present(this.mediaTime);
  }

  get playing() { return !this.video.paused && !this.video.ended; }

  /** True while a seek is being decoded or is waiting its turn. */
  get busy() { return this.video.seeking || this._queued !== null; }

  /**
   * Where we are: while paused, the frame last asked for (so quick successive
   * steps add up even before the picture catches up); otherwise the frame on screen.
   */
  get position() { return this._target ?? this.frame; }

  play() {
    if (!this.loaded) return;
    this._target = null;
    if (this.video.ended) this.video.currentTime = this.map.seekTime(0);
    this.video.play();
  }

  pause() { this.video.pause(); }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** Show frame `n`. Rapid calls are coalesced: only the latest target is decoded. */
  seekFrame(n, { silent = false } = {}) {
    if (!this.loaded) return;
    n = Math.min(Math.max(Math.round(n), 0), this.map.count - 1);
    this._target = this.playing ? null : n; // during playback the position keeps moving
    const t = this.map.seekTime(n);
    if (this.video.seeking) this._queued = t;
    else this.video.currentTime = t;
    if (!silent) {
      this.dispatchEvent(new CustomEvent('seek', { detail: { frame: n, time: this.map.timeOf(n) } }));
    }
  }

  /** Pause and move by `delta` frames. */
  step(delta) {
    if (!this.loaded) return;
    this.pause();
    this.seekFrame(this.position + delta);
  }

  _present(mediaTime) {
    this.mediaTime = mediaTime;
    this.frame = this.map.frameAt(mediaTime);
    this.dispatchEvent(new Event('frame'));
  }
}
