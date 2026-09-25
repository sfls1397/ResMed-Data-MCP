export interface ParsedAnnotation {
  onsetSeconds: number;
  durationSeconds: number | null;
  text: string;
}

/** Decode one EDF+ annotation record (TAL). Empty time-keeping entries are skipped. */
export function parseAnnotations(raw: Uint8Array): ParsedAnnotation[] {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const out: ParsedAnnotation[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (bytes[index] === 0) {
      index += 1;
      continue;
    }
    let cursor = index;
    while (cursor < bytes.length && bytes[cursor] !== 20 && bytes[cursor] !== 21 && bytes[cursor] !== 0) {
      cursor += 1;
    }
    if (cursor >= bytes.length || bytes[cursor] === 0) {
      break;
    }
    const onset = Number(bytes.toString("latin1", index, cursor));
    let duration: number | null = null;
    if (bytes[cursor] === 21) {
      const durationStart = cursor + 1;
      let durationEnd = durationStart;
      while (durationEnd < bytes.length && bytes[durationEnd] !== 20 && bytes[durationEnd] !== 0) {
        durationEnd += 1;
      }
      const durationText = bytes.toString("latin1", durationStart, durationEnd);
      duration = durationText.length > 0 && Number.isFinite(Number(durationText)) ? Number(durationText) : null;
      cursor = durationEnd;
    }
    if (cursor >= bytes.length || bytes[cursor] !== 20) {
      break;
    }
    cursor += 1;
    const texts: string[] = [];
    while (cursor < bytes.length && bytes[cursor] !== 0) {
      const textStart = cursor;
      while (cursor < bytes.length && bytes[cursor] !== 20 && bytes[cursor] !== 0) {
        cursor += 1;
      }
      const text = bytes.toString("latin1", textStart, cursor).trim();
      if (text) {
        texts.push(text);
      }
      if (cursor < bytes.length && bytes[cursor] === 20) {
        cursor += 1;
      }
    }
    if (cursor < bytes.length && bytes[cursor] === 0) {
      cursor += 1;
    }
    if (Number.isFinite(onset)) {
      for (const text of texts) {
        out.push({ onsetSeconds: onset, durationSeconds: duration, text });
      }
    }
    index = cursor;
  }
  return out;
}
