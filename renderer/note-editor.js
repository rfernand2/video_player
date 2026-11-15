// The small text box that appears for Ctrl+N.

export class NoteEditor {
  /** @param {HTMLElement} root contains .note-heading and a <textarea> */
  constructor(root) {
    this.root = root;
    this.heading = root.querySelector('.note-heading');
    this.text = root.querySelector('textarea');
    this._resolve = null;

    this.text.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.close(this.text.value.trim() || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close(null);
      }
    });
  }

  get isOpen() { return this._resolve !== null; }

  /** Show the editor. Resolves with the note text, or null if cancelled/empty. */
  open(heading) {
    this.heading.textContent = heading;
    this.text.value = '';
    this.root.hidden = false;
    this.text.focus();
    return new Promise((resolve) => { this._resolve = resolve; });
  }

  close(result) {
    const resolve = this._resolve;
    this._resolve = null;
    this.root.hidden = true;
    this.text.blur();
    resolve?.(result);
  }
}
