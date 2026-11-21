// =============================================================
// Credencial de publicación para el relay MoQ (HS256)
// -------------------------------------------------------------
// `moq auth serve` (servidor de auth de referencia del relay) verifica el
// `?jwt=` contra una clave JWK. Buncaster genera esa clave en el volumen de
// secretos (0600, nunca en el repo) y firma tokens cortos para sí mismo:
// solo él puede publicar; los oyentes entran anónimos con permiso de lectura.
// Formato idéntico al de `moq auth generate --algorithm HS256` (JWK en
// base64url) y a `moq auth sign` (claims root/publish/exp).
// =============================================================
import { createHmac, randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { writeAtomic } from "./cert";

export interface HmacJwk {
  alg: "HS256";
  key_ops: string[];
  kty: "oct";
  k: string;
  kid: string;
}

const b64u = (b: Buffer | Uint8Array | string) => Buffer.from(b as any).toString("base64url");

export function generateJwk(): HmacJwk {
  return { alg: "HS256", key_ops: ["sign", "verify"], kty: "oct", k: b64u(randomBytes(32)), kid: randomBytes(8).toString("hex") };
}

/** Lee la clave (formato de `moq auth generate`: JSON en base64url, o JSON plano). */
export function parseJwk(text: string): HmacJwk {
  const t = text.trim();
  const json = t.startsWith("{") ? t : Buffer.from(t, "base64url").toString("utf8");
  const jwk = JSON.parse(json) as HmacJwk;
  if (jwk.kty !== "oct" || jwk.alg !== "HS256" || !jwk.k) throw new Error("MOQ: clave JWK no es HS256/oct");
  return jwk;
}

/** Crea la clave si no existe y la devuelve. */
export function ensureJwk(path: string, ownerUid?: number): HmacJwk {
  if (existsSync(path)) return parseJwk(readFileSync(path, "utf8"));
  const jwk = generateJwk();
  writeAtomic(path, b64u(JSON.stringify(jwk)), 0o600, ownerUid);
  return jwk;
}

/** JWT HS256 con los claims que entiende `moq auth serve` (cualquier otro lo rechaza). */
export function signPublishToken(jwk: HmacJwk, opts: { root: string; publish: string[]; ttlSec: number; now?: number }): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "HS256", kid: jwk.kid }));
  const payload = b64u(JSON.stringify({ root: opts.root, publish: opts.publish, iat: now, exp: now + opts.ttlSec }));
  const sig = createHmac("sha256", Buffer.from(jwk.k, "base64url")).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
