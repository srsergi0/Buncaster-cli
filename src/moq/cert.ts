// =============================================================
// Certificados efímeros para WebTransport `serverCertificateHashes`
// -------------------------------------------------------------
// El canal MoQ va directo a la IP del servidor por UDP (Cloudflare Tunnel
// no reenvía QUIC), así que no hay certificado de una CA. W3C WebTransport
// permite fijar el certificado por hash si es X.509v3, ECDSA P-256 y su
// validez total es ≤ 14 días. Este módulo:
//   - genera ese certificado con WebCrypto (sin openssl): DER a mano,
//   - lo rota antes de caducar con solape: siempre hay un `next` publicado
//     junto al activo, de modo que un cliente que pidió los hashes justo
//     antes de la rotación sigue conectando,
//   - escribe cert/clave en un directorio fuera del repo (volumen), clave 0600.
// El relay (moq-relay) lee `cert.pem`/`key.pem` y los recarga al cambiar.
// =============================================================
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { X509Certificate, createHash } from "crypto";

const DAY_MS = 86_400_000;
/** Límite de W3C WebTransport para serverCertificateHashes. */
export const MAX_VALIDITY_DAYS = 14;

// ---------- DER mínimo ----------
function derLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([Uint8Array.of(tag), derLen(body.length), body]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
const set = (...p: Uint8Array[]) => tlv(0x31, ...p);
function oid(dotted: string): Uint8Array {
  const a = dotted.split(".").map(Number);
  const out: number[] = [a[0]! * 40 + a[1]!];
  for (const v of a.slice(2)) {
    const tmp: number[] = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) { tmp.unshift(0x80 | (x & 0x7f)); x >>= 7; }
    out.push(...tmp);
  }
  return tlv(0x06, Uint8Array.from(out));
}
function uint(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let b = bytes.subarray(i);
  if (b[0]! & 0x80) b = concat([Uint8Array.of(0), b]);
  return tlv(0x02, b);
}
function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
}
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const octets = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array) => tlv(0x03, Uint8Array.of(0), b);
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 + n, inner);

function ipBytes(ip: string): Uint8Array | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return Uint8Array.from(m.slice(1).map(Number));
}

/** Firma ECDSA de WebCrypto (r||s, IEEE P1363) → DER SEQUENCE { INTEGER r, INTEGER s }. */
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  return seq(uint(sig.subarray(0, half)), uint(sig.subarray(half)));
}

function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export interface GeneratedCert {
  certPem: string;
  keyPem: string;
  /** SHA-256 del certificado DER, en hex (lo que el navegador compara). */
  sha256: string;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Certificado X.509v3 autofirmado ECDSA P-256 / SHA-256 apto para
 * `serverCertificateHashes` (validez ≤ 14 días). `names` van al SAN
 * (DNS o IPv4); el navegador no los comprueba con hash, pero rustls/quinn sí
 * necesita un certificado bien formado.
 */
export async function generateCert(opts: { days: number; names?: string[]; now?: Date }): Promise<GeneratedCert> {
  const days = Math.min(opts.days, MAX_VALIDITY_DAYS);
  if (!(days > 0)) throw new Error(`MOQ cert: validez inválida (${opts.days} días)`);
  const now = opts.now ?? new Date();
  // Un minuto hacia atrás por desfase de relojes; el total sigue ≤ `days`.
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000);
  const notAfter = new Date(notBefore.getTime() + days * DAY_MS);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));

  const names = opts.names?.length ? opts.names : ["localhost"];
  const sanEntries = names.map((n) => {
    const ip = ipBytes(n);
    return ip ? tlv(0x87, ip) : tlv(0x82, new TextEncoder().encode(n));
  });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), utf8("buncaster-moq"))));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f;
  const extensions = explicit(3, seq(
    // keyUsage: digitalSignature (crítica)
    seq(oid("2.5.29.15"), tlv(0x01, Uint8Array.of(0xff)), octets(tlv(0x03, Uint8Array.of(7, 0x80)))),
    // extKeyUsage: serverAuth
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))),
    // basicConstraints: CA:FALSE
    seq(oid("2.5.29.19"), tlv(0x01, Uint8Array.of(0xff)), octets(seq())),
    // subjectAltName
    seq(oid("2.5.29.17"), octets(seq(...sanEntries))),
  ));
  const tbs = seq(
    explicit(0, uint(Uint8Array.of(2))), // v3
    uint(serial),
    ecdsaSha256,
    name,
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    extensions,
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, tbs as Uint8Array<ArrayBuffer>));
  const der = seq(tbs, ecdsaSha256, bits(p1363ToDer(sig)));
  return {
    certPem: pem("CERTIFICATE", der),
    keyPem: pem("PRIVATE KEY", pkcs8),
    sha256: createHash("sha256").update(der).digest("hex"),
    notBefore,
    notAfter,
  };
}

export interface CertInfo {
  sha256: string;
  notBefore: Date;
  notAfter: Date;
}

/** Hash y validez de un PEM ya escrito (null si no existe o no se puede leer). */
export function readCertInfo(certPath: string): CertInfo | null {
  try {
    const x = new X509Certificate(readFileSync(certPath));
    return {
      sha256: createHash("sha256").update(x.raw).digest("hex"),
      notBefore: new Date(x.validFrom),
      notAfter: new Date(x.validTo),
    };
  } catch {
    return null;
  }
}

/**
 * Escribe con rename atómico. Si somos root y hay `ownerUid`, el archivo pasa a
 * ese usuario (el del relay, que corre sin privilegios) sin abrir permisos: 0600.
 */
export function writeAtomic(path: string, data: string, mode: number, ownerUid?: number) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  if (ownerUid !== undefined && ownerUid >= 0 && process.getuid?.() === 0) {
    try { chownSync(tmp, ownerUid, ownerUid); } catch { /* sin permiso: queda del proceso */ }
  }
  renameSync(tmp, path);
}

export interface CertManagerOptions {
  dir: string;
  /** Validez de cada certificado (≤ 14). */
  days: number;
  /** Edad del activo a partir de la cual se promueve el `next`. */
  rotateAfterDays: number;
  /** Tiempo mínimo que un `next` lleva publicado antes de promoverlo (solape). */
  overlapMs: number;
  names: string[];
  /** uid dueño de los archivos (el del relay); solo se aplica si corremos como root. */
  ownerUid?: number;
}

/**
 * Par activo/siguiente en disco:
 *   cert.pem + key.pem   → lo que sirve el relay
 *   next.pem + next.key  → pre-generado y ya anunciado a los clientes
 * `hashes()` devuelve ambos para `serverCertificateHashes`.
 */
export class CertManager {
  readonly certPath: string;
  readonly keyPath: string;
  readonly nextCertPath: string;
  readonly nextKeyPath: string;
  rotations = 0;
  private active: CertInfo | null = null;
  private next: CertInfo | null = null;
  private nextPublishedAt = 0;

  constructor(readonly opts: CertManagerOptions) {
    this.certPath = join(opts.dir, "cert.pem");
    this.keyPath = join(opts.dir, "key.pem");
    this.nextCertPath = join(opts.dir, "next.pem");
    this.nextKeyPath = join(opts.dir, "next.key");
  }

  /** Crea o rota lo necesario. Devuelve true si cambió el certificado activo. */
  async ensure(now = new Date()): Promise<boolean> {
    if (!existsSync(this.opts.dir)) mkdirSync(this.opts.dir, { recursive: true, mode: 0o755 });
    this.active = readCertInfo(this.certPath);
    this.next = readCertInfo(this.nextCertPath);
    if (this.next && this.nextPublishedAt === 0) this.nextPublishedAt = now.getTime();
    let changed = false;
    const t = now.getTime();
    const usable = (c: CertInfo | null) =>
      !!c && c.notBefore.getTime() <= t && c.notAfter.getTime() - t > DAY_MS / 24 &&
      c.notAfter.getTime() - c.notBefore.getTime() <= MAX_VALIDITY_DAYS * DAY_MS;

    if (!usable(this.active) || !existsSync(this.keyPath)) {
      // Sin activo válido: el `next` si sirve (ya anunciado) o uno nuevo.
      if (usable(this.next) && existsSync(this.nextKeyPath)) this.promote();
      else await this.write(this.certPath, this.keyPath, now);
      changed = true;
    } else if (
      t - this.active!.notBefore.getTime() >= this.opts.rotateAfterDays * DAY_MS &&
      usable(this.next) && existsSync(this.nextKeyPath) &&
      t - this.nextPublishedAt >= this.opts.overlapMs
    ) {
      this.promote();
      changed = true;
    }
    if (!usable(this.next) || !existsSync(this.nextKeyPath)) {
      await this.write(this.nextCertPath, this.nextKeyPath, now);
      this.nextPublishedAt = t;
    }
    this.active = readCertInfo(this.certPath);
    this.next = readCertInfo(this.nextCertPath);
    if (changed) this.rotations++;
    return changed;
  }

  private promote() {
    // La clave primero: el relay recarga al ver cambiar el certificado.
    renameSync(this.nextKeyPath, this.keyPath);
    renameSync(this.nextCertPath, this.certPath);
    this.next = null;
  }

  private async write(certPath: string, keyPath: string, now: Date) {
    const c = await generateCert({ days: this.opts.days, names: this.opts.names, now });
    writeAtomic(keyPath, c.keyPem, 0o600, this.opts.ownerUid);
    writeAtomic(certPath, c.certPem, 0o644, this.opts.ownerUid);
  }

  /** Hashes vigentes (activo primero) para `serverCertificateHashes`. */
  hashes(): { sha256: string; notAfter: string }[] {
    const out: { sha256: string; notAfter: string }[] = [];
    for (const c of [this.active, this.next]) if (c) out.push({ sha256: c.sha256, notAfter: c.notAfter.toISOString() });
    return out;
  }

  get activeInfo(): CertInfo | null { return this.active; }
}
