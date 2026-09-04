import { config } from "./config";
import { rtmpLog } from "./logger";

export interface Mp3FrameInfo {
  bitrateKbps: number;
  sampleRate: number;
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const SAMPLE_RATES_MPEG1 = [44100, 48000, 32000, -1];
const SAMPLE_RATES_MPEG2 = [22050, 24000, 16000, -1];
const SAMPLE_RATES_MPEG25 = [11025, 12000, 8000, -1];

function findMp3FrameInfo(buf: Uint8Array): Mp3FrameInfo | null {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const b2 = buf[i + 1];
    if (b2 === undefined || (b2 & 0xe0) !== 0xe0) continue;

    const versionBits = (b2 >> 3) & 0b11;
    const layerBits = (b2 >> 1) & 0b11;
    if (versionBits === 0b01 || layerBits !== 0b01) continue;

    const b3 = buf[i + 2];
    if (b3 === undefined) continue;
    const bitrateIndex = (b3 >> 4) & 0x0f;
    const sampleRateIndex = (b3 >> 2) & 0b11;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0b11) continue;

    const isMpeg1 = versionBits === 0b11;
    const bitrateKbps = (isMpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
    if (bitrateKbps === undefined || bitrateKbps <= 0) continue;

    const sampleRate = isMpeg1
      ? SAMPLE_RATES_MPEG1[sampleRateIndex]
      : versionBits === 0b10
        ? SAMPLE_RATES_MPEG2[sampleRateIndex]
        : SAMPLE_RATES_MPEG25[sampleRateIndex];
    if (sampleRate === undefined || sampleRate <= 0) continue;

    return { bitrateKbps, sampleRate };
  }
  return null;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export class BitrateDetector {
  private acc: Uint8Array | null = null;
  private done = false;
  private readonly maxAccBytes = 8192;

  constructor(private readonly onDetected: (info: Mp3FrameInfo) => void) { }

  feed(chunk: Uint8Array): void {
    if (this.done) return;

    // Para formatos no-MP3, usar bitrate de config directamente
    if (config.streamFormat !== "mp3") {
      this.done = true;
      this.onDetected({ bitrateKbps: config.fallbackBitrateKbps, sampleRate: 48000 });
      return;
    }

    this.acc = this.acc ? concatBytes(this.acc, chunk) : chunk;

    const info = findMp3FrameInfo(this.acc);
    if (info) {
      this.done = true;
      this.acc = null;
      this.onDetected(info);
      return;
    }

    if (this.acc.byteLength > this.maxAccBytes) {
      this.done = true;
      this.acc = null;
      rtmpLog.warn(
        `No se pudo autodetectar el bitrate del MP3 tras ${this.maxAccBytes} bytes; ` +
        `usando predeterminado de ${config.fallbackBitrateKbps}kbps`
      );
    }
  }

  reset(): void {
    this.acc = null;
    this.done = false;
  }
}
export const bitrateDetector = new BitrateDetector((info) => {
  rtmpLog.info(`Detected real bitrate: ${info.bitrateKbps}kbps @ ${info.sampleRate}Hz`);
});
