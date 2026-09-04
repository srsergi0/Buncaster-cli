import { rtmpLog } from "./logger";

export type StreamFormat = "mp3" | "ogg" | "aac" | "flac" | "opus";

export interface FormatConfig {
  codec: string;
  muxer: string;
  mime: string;
  args: (bitrate: number) => string[];
  defaultBitrate: number;
}

export const FORMAT_CONFIG: Record<StreamFormat, FormatConfig> = {
  mp3: {
    codec: "libmp3lame",
    muxer: "mp3",
    mime: "audio/mpeg",
    args: (bitrate) => ["-ab", `${bitrate}k`],
    defaultBitrate: 320,
  },
  ogg: {
    codec: "libvorbis",
    muxer: "ogg",
    mime: "audio/ogg; codecs=vorbis",
    args: () => ["-q:a", "6"],
    defaultBitrate: 128,
  },
  opus: {
    codec: "libopus",
    muxer: "opus",
    mime: "audio/ogg; codecs=opus",
    args: (bitrate) => ["-b:a", `${bitrate}k`],
    defaultBitrate: 128,
  },
  aac: {
    codec: "aac",
    muxer: "adts",
    mime: "audio/aac",
    args: (bitrate) => ["-ab", `${bitrate}k`],
    defaultBitrate: 128,
  },
  flac: {
    codec: "flac",
    muxer: "flac",
    mime: "audio/flac",
    args: () => ["-compression_level", "5"],
    defaultBitrate: 0,
  },
};

export function isCodecAvailable(format: StreamFormat): boolean {
  const codec = FORMAT_CONFIG[format].codec;
  try {
    const proc = Bun.spawnSync(["ffmpeg", "-encoders"], { stdout: "pipe", stderr: "pipe" });
    const output = new TextDecoder().decode(proc.stdout);
    return output.includes(codec);
  } catch {
    return false;
  }
}

export function validateFormat(format: StreamFormat): StreamFormat {
  if (FORMAT_CONFIG[format] && isCodecAvailable(format)) {
    return format;
  }
  rtmpLog.warn(`Codec for "${format}" not available, fallback to MP3`);
  return "mp3";
}
