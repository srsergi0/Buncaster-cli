import { describe, it, expect } from "bun:test";
import { checkAdminAuth } from "../src/http-helpers";
import { config } from "../src/config";

describe("Admin Authentication & Access Control", () => {
  it("permits access when admin password is empty (local dev / backward compat)", () => {
    const origPass = config.adminPassword;
    (config as any).adminPassword = "";

    const req = new Request("http://localhost:8080/api/skip", { method: "POST" });
    expect(checkAdminAuth(req)).toBe(true);

    (config as any).adminPassword = origPass;
  });

  it("requires valid credentials when admin password is configured", () => {
    const origUser = config.adminUser;
    const origPass = config.adminPassword;
    (config as any).adminUser = "admin";
    (config as any).adminPassword = "secret-radio-pwd";

    // 1. Sin header
    const reqNoAuth = new Request("http://localhost:8080/api/skip", { method: "POST" });
    expect(checkAdminAuth(reqNoAuth)).toBe(false);

    // 2. Credenciales incorrectas
    const wrongCredentials = btoa("admin:wrongpassword");
    const reqBadAuth = new Request("http://localhost:8080/api/skip", {
      method: "POST",
      headers: { Authorization: `Basic ${wrongCredentials}` },
    });
    expect(checkAdminAuth(reqBadAuth)).toBe(false);

    // 3. Credenciales correctas
    const validCredentials = btoa("admin:secret-radio-pwd");
    const reqGoodAuth = new Request("http://localhost:8080/api/skip", {
      method: "POST",
      headers: { Authorization: `Basic ${validCredentials}` },
    });
    expect(checkAdminAuth(reqGoodAuth)).toBe(true);

    // 4. Token Bearer con streamKey válida
    const reqBearer = new Request("http://localhost:8080/api/skip", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.rtmpStreamKey}` },
    });
    expect(checkAdminAuth(reqBearer)).toBe(true);

    // Restaurar
    (config as any).adminUser = origUser;
    (config as any).adminPassword = origPass;
  });
});
