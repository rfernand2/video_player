// The seek bar: playhead, shot boundaries (ticks) and note markers.
// Colours come from CSS custom properties on the element (see styles.css).

export class Timeline {
  /**
   * @param {HTMLElement} el contains <canvas>, .fill and .head
   * @param {object} handlers
   * @param {(time: number) => void} handlers.onSeek   pointer is at this media time
   * @param {() => void} [handlers.onDragStart]
   * @param {() => void} [handlers.onDragEnd]
   */
  constructor(el, { onSeek, onDragStart, onDragEnd }) {
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.fill = el.querySelector('.fill');
    this.head = el.querySelector('.head');
    this.start = 0;
    this.end = 1;
    this.cuts = [];
    this.notes = [];
    this.knownUntil = Infinity;
    this.dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      onDragStart?.();
      onSeek(this.#timeAt(e));
    });
    el.addEventListener('pointermove', (e) => {
      if (this.dragging) onSeek(this.#timeAt(e));
    });
    const release = () => {
      if (!this.dragging) return;
      this.dragging = false;
      onDragEnd?.();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    new ResizeObserver(() => this.draw()).observe(el);
  }

  setRange(start, end) {
    this.start = start;
    this.end = Math.max(end, start + 1e-6);
    this.draw();
  }

  setPosition(time) {
    const percent = `${this.#fraction(time) * 100}%`;
    this.fill.style.width = percent;
    this.head.style.left = percent;
  }

  /** @param {{ cuts?: number[], notes?: number[], knownUntil?: number }} marks media times */
  setMarks(marks) {
    Object.assign(this, marks);
    this.draw();
  }

  draw() {
    const { canvas } = this;
    const width = Math.round(canvas.clientWidth * devicePixelRatio);
    const height = Math.round(canvas.clientHeight * devicePixelRatio);
    if (!width || !height) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const g = canvas.getContext('2d');
    const css = getComputedStyle(this.el);
    const x = (time) => Math.round(this.#fraction(time) * (width - 1));
    g.clearRect(0, 0, width, height);

    // Part of the video not analysed for shots yet.
    if (this.knownUntil < this.end) {
      g.fillStyle = css.getPropertyValue('--pending');
      const from = x(Math.max(this.knownUntil, this.start));
      g.fillRect(from, 0, width - from, height);
    }

    g.fillStyle = css.getPropertyValue('--cut');
    const tick = Math.max(1, Math.round(devicePixelRatio));
    for (const time of this.cuts) g.fillRect(x(time), 0, tick, height);

    g.fillStyle = css.getPropertyValue('--note');
    const r = 3.5 * devicePixelRatio;
    for (const time of this.notes) {
      const cx = x(time);
      g.beginPath();
      g.moveTo(cx - r, 0);
      g.lineTo(cx + r, 0);
      g.lineTo(cx, r * 1.6);
      g.closePath();
      g.fill();
    }
  }

  #fraction(time) {
    return Math.min(1, Math.max(0, (time - this.start) / (this.end - this.start)));
  }

  #timeAt(event) {
    const box = this.el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    return this.start + fraction * (this.end - this.start);
  }
}
