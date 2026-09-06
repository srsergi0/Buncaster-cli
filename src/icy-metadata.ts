const META_INTERVAL = 65536;

const metaBlockCache = new Map<string, Uint8Array>();
const EMPTY_META_BLOCK = new Uint8Array([0]);

export function buildMetadataBlock(streamTitle: string): Uint8Array {
  if (!streamTitle) return EMPTY_META_BLOCK;
  const cached = metaBlockCache.get(streamTitle);
  if (cached) return cached;

  const trimmed = streamTitle.slice(0, 400).replace(/'/g, "\\'");
  const encoded = new TextEncoder().encode(`StreamTitle='${trimmed}';StreamUrl='';`);
  const blockSize = Math.ceil((encoded.length + 1) / 16) * 16;
  const buf = new Uint8Array(blockSize + 1);
  buf[0] = blockSize / 16;
  buf.set(encoded, 1);

  metaBlockCache.set(streamTitle, buf);
  return buf;
}

export interface IcyClientState {
  bytesSinceMeta: number;
  metaInterval: number;
}

export function createIcyState(): IcyClientState {
  return {
    bytesSinceMeta: 0,
    metaInterval: META_INTERVAL,
  };
}

export function chunkWithIcy(
  chunk: Uint8Array,
  state: IcyClientState,
  title: string,
): Uint8Array[] {
  const result: Uint8Array[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    const remaining = chunk.length - offset;
    const space = state.metaInterval - state.bytesSinceMeta;

    if (remaining < space) {
      const piece = offset === 0 && remaining === chunk.length ? chunk : chunk.subarray(offset);
      result.push(piece);
      state.bytesSinceMeta += remaining;
      offset = chunk.length;
    } else {
      // Chunk de audio hasta el intervalo de metadata
      result.push(chunk.subarray(offset, offset + space));
      state.bytesSinceMeta += space;
      offset += space;

      // Inyectar bloque de metadatos (0x00 si título vacío o bloque formateado)
      const metaBlock = buildMetadataBlock(title);
      result.push(metaBlock);
      state.bytesSinceMeta = 0;
    }
  }

  return result;
}
