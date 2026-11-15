// The notes file format. Pure module: text in, text out.
//
//   # Notes — clip.mp4            <- anything before the first note is kept as-is
//
//   ## Shot 3                     <- one group per shot (regenerated on every save)
//
//   ### Shot 3 · 00:00:12:18      <- one heading per note: shot number + timecode
//
//   Free-form markdown body.
//
// The timecode is the source of truth. Shot numbers are derived from it each
// time the file is written, so they follow changes in shot detection.

const TC = String.raw`\d{2,}:\d{2}:\d{2}[:;]\d{2,3}`;
const GROUP_RE = /^##\s+Shot\s+(\d+|\?)\s*$/;
const NOTE_RE = new RegExp(String.raw`^###\s+(?:Shot\s+(\d+|\?)\s*[·|,–—-]?\s*)?(${TC})\s*$`);

/**
 * @returns {{ preamble: string, notes: { tc: string, shot: string|null, text: string }[] }}
 *   `shot` is the number written in the file ('?' if unknown, null if absent).
 */
export function parseNotes(md) {
  const preamble = [];
  const notes = [];
  let body = preamble;

  for (const line of (md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = NOTE_RE.exec(line);
    if (m) {
      body = [];
      notes.push({ tc: m[2], shot: m[1] ?? null, body });
    } else if (GROUP_RE.test(line)) {
      // Group headings are regenerated. Stray text typed under one stays with
      // the note above it (minus the blank lines that surrounded the heading).
      while (body.length > 0 && body.at(-1).trim() === '') body.pop();
    } else {
      body.push(line);
    }
  }
  return {
    preamble: trimBlankLines(preamble.join('\n')),
    notes: notes.map(({ tc, shot, body }) => ({ tc, shot, text: trimBlankLines(body.join('\n')) })),
  };
}

/**
 * @param {{ preamble: string, notes: { tc: string, text: string }[] }} doc
 * @param {object} o
 * @param {string} o.title    used for the heading of a brand-new file
 * @param {(tc: string) => number|null} o.frameOf  timecode -> frame index
 * @param {(frame: number) => number|null} o.shotOf frame -> shot number (null = unknown)
 */
export function renderNotes(doc, { title, frameOf, shotOf }) {
  const notes = sortNotes(doc.notes, frameOf);
  let out = doc.preamble || `# Notes — ${title}`;
  let group;
  for (const note of notes) {
    const label = shotLabel(note.frame, shotOf);
    if (label !== group) {
      out += `\n\n## Shot ${label}`;
      group = label;
    }
    out += `\n\n### Shot ${label} · ${note.tc}\n\n${note.text}`;
  }
  return out + '\n';
}

/** True when a shot number written in the file no longer matches detection. */
export function shotNumbersStale(doc, { frameOf, shotOf }) {
  return doc.notes.some((note) => note.shot !== shotLabel(frameOf(note.tc), shotOf));
}

/** Notes in timecode order (stable), each with its frame index. */
export function sortNotes(notes, frameOf) {
  return notes
    .map((note, order) => ({ ...note, frame: frameOf(note.tc), order }))
    .sort((a, b) => (a.frame ?? Infinity) - (b.frame ?? Infinity) || a.order - b.order);
}

function shotLabel(frame, shotOf) {
  const shot = frame == null ? null : shotOf(frame);
  return shot == null ? '?' : String(shot);
}

function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}
