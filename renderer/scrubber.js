// Audio scrubbing: plays a short snippet of audio at the position you step or
// drag to while paused. Audio comes from a PCM copy of the soundtrack that the
// main process keeps on disk (see main.js 'media:scrub-audio').

export class Scrubber {
  /** @param {object} api window.api  @param {object} options config.scrub */
  constructor(api, options) {
    this.api = api;
    this.options = options;
    this.enabled = options.enabledByDefault;
    this.volume = 1;
    this.source = null;   // { sampleRate, sampleCount } once the track is ready
    this.played = 0;      // snippets started (handy when debugging)
    this._ctx = null;
    this._voice = null;   // snippet currently sounding
    this._request = 0;
    this._pending = null;
    this._timer = null;
    this._lastStart = 0;
  }

  get available() { return this.source !== null; }

  /** Call when another video is opened. */
  reset() {
    this.source = null;
    this._pending = null;
    this._request++;
    this._silence();
  }

  setSource(source) { this.source = source ?? null; }

  /** Ask for the audio at media time `time`; `frameDuration` sizes the snippet. */
  play(time, frameDuration) {
    if (!this.enabled || !this.source || this.volume <= 0) return;
    this._pending = { time, frameDuration };
    if (this._timer !== null) return;
    // Rate-limited so that dragging the timeline doesn't turn into a buzz.
    const wait = Math.max(0, this._lastStart + this.options.minGapMs - performance.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      this._lastStart = performance.now();
      const next = this._pending;
      this._pending = null;
      if (next) this._start(next.time, next.frameDuration);
    }, wait);
  }

  async _start(time, frameDuration) {
    const { sampleRate, sampleCount } = this.source;
    const seconds = Math.max(this.options.minSnippetMs / 1000, frameDuration * this.options.snippetFrames);
    const first = Math.max(0, Math.round(time * sampleRate));
    const count = Math.min(Math.round(seconds * sampleRate), sampleCount - first);
    if (count <= 0) return;

    const request = ++this._request;
    const pcm = await this.api.readAudio(first, count);
    if (request !== this._request || !pcm || pcm.length === 0) return; // superseded

    const ctx = (this._ctx ??= new AudioContext({ latencyHint: 'interactive' }));
    if (ctx.state === 'suspended') await ctx.resume();
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;

    const node = ctx.createBufferSource();
    const gain = ctx.createGain();
    node.buffer = buffer;
    node.connect(gain).connect(ctx.destination);

    const now = ctx.currentTime;
    const fade = Math.min(this.options.fadeMs / 1000, buffer.duration / 2);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.volume, now + fade);
    gain.gain.setValueAtTime(this.volume, now + buffer.duration - fade);
    gain.gain.linearRampToValueAtTime(0, now + buffer.duration);

    this._silence();
    node.start(now);
    this._voice = { node, gain };
    this.played++;
  }

  /** Fade out whatever is sounding. */
  _silence() {
    const voice = this._voice;
    if (!voice || !this._ctx) return;
    this._voice = null;
    const now = this._ctx.currentTime;
    const fade = this.options.fadeMs / 1000;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + fade);
    voice.node.stop(now + fade + 0.01);
  }
}
