import { config } from "./config";

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
  };
}

export function checkStreamKey(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === config.rtmpStreamKey;
}

export function checkAdminAuth(req: Request): boolean {
  // Si no se configuró contraseña de admin, permitimos acceso en desarrollo/local
  if (!config.adminPassword) return true;

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === config.rtmpStreamKey;
  }

  if (authHeader.startsWith("Basic ")) {
    try {
      const b64 = authHeader.slice(6).trim();
      const decoded = atob(b64);
      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) return false;
      const user = decoded.slice(0, colonIdx);
      const pass = decoded.slice(colonIdx + 1);
      return user === config.adminUser && pass === config.adminPassword;
    } catch {
      return false;
    }
  }

  return false;
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Admin", Bearer realm="BunRadio"',
      ...corsHeaders(),
    },
  });
}

export function getClientIp(req: Request, server: Bun.Server<undefined>): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return server.requestIP(req)?.address ?? "unknown";
}
