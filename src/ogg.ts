// =============================================================
// Ensamblador incremental de páginas Ogg (RFC 3533 / RFC 7845)
// -------------------------------------------------------------
// La salida de ffmpeg llega por un pipe en lecturas de tamaño
// arbitrario: una lectura puede contener media página, varias páginas
// o cortar la cabecera. Este ensamblador devuelve SOLO páginas
// completas, de modo que el prebuffer de un oyente nuevo empiece
// siempre en un límite de página y las cabeceras OpusHead/OpusTags se
// capturen enteras aunque lleguen en lecturas distintas.
// =============================================================

export interface OggPage {
  data: Uint8Array;
  /** header_type & 0x02: primera página de un stream lógico (OpusHead). */
  bos: boolean;
  /** header_type & 0x04: última página del stream lógico. */
  eos: boolean;
  /** Granule position (muestras a 48 kHz en Opus). 0 en páginas de cabecera. */
  granule: bigint;
  serial: number;
  /** Primeros 8 bytes del payload ("OpusHead", "OpusTags", …). */
  magic: string;
}

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const MAX_PAGE = 27 + 255 + 255 * 255;

export class OggPageAssembler {
  private buf: Uint8Array = new Uint8Array(0);
  /** Bytes descartados buscando el patrón "OggS" (debería ser 0). */
  public skippedBytes = 0;

  feed(chunk: Uint8Array): OggPage[] {
    if (chunk.byteLength === 0) return [];
    if (this.buf.byteLength === 0) {
      this.buf = chunk;
    } else {
      const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.byteLength);
      this.buf = merged;
    }

    const pages: OggPage[] = [];
    let off = 0;
    const b = this.buf;
    while (true) {
      // Resincronizar al siguiente "OggS" si hay basura
      if (off + 4 <= b.length && !isCapture(b, off)) {
        const next = findCapture(b, off + 1);
        const skipTo = next === -1 ? Math.max(off, b.length - 3) : next;
        this.skippedBytes += skipTo - off;
        off = skipTo;
        if (next === -1) break;
      }
      if (off + 27 > b.length) break;
      const nSeg = b[off + 26]!;
      if (off + 27 + nSeg > b.length) break;
      let payload = 0;
      for (let i = 0; i < nSeg; i++) payload += b[off + 27 + i]!;
      const len = 27 + nSeg + payload;
      if (len > MAX_PAGE) { off += 1; continue; }
      if (off + len > b.length) break;

      const data = b.slice(off, off + len); // copia inmutable
      const headerType = data[5]!;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const granule = view.getBigUint64(6, true);
      const serial = view.getUint32(14, true);
      const p0 = 27 + nSeg;
      let magic = "";
      for (let i = p0; i < Math.min(p0 + 8, data.length); i++) magic += String.fromCharCode(data[i]!);
      pages.push({ data, bos: (headerType & 0x02) !== 0, eos: (headerType & 0x04) !== 0, granule, serial, magic });
      off += len;
    }
    this.buf = off >= b.length ? new Uint8Array(0) : b.slice(off);
    return pages;
  }

  /** Bytes pendientes (página incompleta). */
  get pending(): number {
    return this.buf.byteLength;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

function isCapture(b: Uint8Array, off: number): boolean {
  return b[off] === CAPTURE[0] && b[off + 1] === CAPTURE[1] && b[off + 2] === CAPTURE[2] && b[off + 3] === CAPTURE[3];
}

function findCapture(b: Uint8Array, from: number): number {
  for (let i = from; i + 4 <= b.length; i++) if (isCapture(b, i)) return i;
  return -1;
}

/**
 * Acumula las páginas de cabecera de un stream Ogg/Opus: la página BOS
 * (OpusHead) y las siguientes con granule 0 (OpusTags, que puede ocupar
 * varias páginas). `headers` refleja en todo momento las páginas de
 * cabecera vistas de la generación actual, de modo que un oyente que
 * conecte a mitad de la cabecera reciba lo ya emitido y el resto en vivo.
 */
export class OpusHeaderCollector {
  private pages: Uint8Array[] = [];
  private done = false;
  public headers: Uint8Array | null = null;

  /** Devuelve true si la página pertenece a la cabecera (no debe ir al prebuffer de audio). */
  accept(page: OggPage): boolean {
    if (page.bos) {
      this.pages = [page.data];
      this.done = false;
      this.headers = concat(this.pages);
      return true;
    }
    if (!this.done && this.pages.length > 0 && page.granule === 0n) {
      this.pages.push(page.data);
      this.headers = concat(this.pages);
      return true;
    }
    if (this.pages.length > 0) this.done = true;
    return false;
  }

  /** true cuando ya se vio OpusHead + OpusTags y llegó la primera página de audio. */
  get isComplete(): boolean {
    return this.done && this.pages.length >= 2;
  }

  reset(): void {
    this.pages = [];
    this.done = false;
    this.headers = null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
