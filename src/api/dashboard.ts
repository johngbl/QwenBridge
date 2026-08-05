import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import fs from "fs";
import path from "path";
import { config } from "../core/config.js";
import { maskEmail } from "../core/logger.js";
import { loadAccounts } from "../core/accounts.js";
import {
  getAccountCooldownInfo,
  getCooldownStatus,
} from "../core/account-manager.js";
import { getPlaywrightStatus } from "../services/playwright.js";

const app = new Hono();

const DASHBOARD_PATH = path.resolve(
  import.meta.dirname ?? process.cwd(),
  "..",
  "dashboard",
  "index.html",
);

function internalBaseUrl(): string {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return `http://${host}:${config.server.port}`;
}

function apiKey(): string | undefined {
  return process.env.API_KEY || config.apiKey;
}

function withApiKey(headers: Record<string, string>): Record<string, string> {
  const key = apiKey();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function forwardToV1(
  c: Context,
  v1Path: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
): Promise<Response> {
  const url = internalBaseUrl() + v1Path;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  withApiKey(headers);

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const upstreamHeaders = new Headers();
    upstreamHeaders.set("Content-Type", "application/json");
    if (upstream.headers.get("x-request-id")) {
      upstreamHeaders.set("X-Request-Id", upstream.headers.get("x-request-id")!);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstreamHeaders,
    });
  } catch (err) {
    return c.json(
      {
        error: {
          message: `Internal proxy error: ${err instanceof Error ? err.message : String(err)}`,
          type: "internal_error",
        },
      },
      500,
    );
  }
}

function accountReadyCount(): number {
  const status = getPlaywrightStatus();
  const cooldowns = getCooldownStatus();
  return loadAccounts().filter(
    (a) => status[a.id]?.hasHeaders && !cooldowns[a.id],
  ).length;
}

// ─── Static dashboard ─────────────────────────────────────────────────────────

app.get("/", (c) => serveDashboard(c));
app.get("/dashboard", (c) => serveDashboard(c));

function serveDashboard(c: Context): Response {
  try {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf-8");
    return c.html(html);
  } catch (err) {
    return c.text(
      `Dashboard not found at ${DASHBOARD_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

// ─── Health (dashboard-compatible shape) ─────────────────────────────────────

app.get("/api/health", async (c) => {
  const accounts = loadAccounts();
  const status = getPlaywrightStatus();
  const cooldowns = getCooldownStatus();
  const available = accounts.filter(
    (a) => status[a.id]?.hasHeaders && !cooldowns[a.id],
  ).length;
  const invalid = accounts.filter((a) => cooldowns[a.id]).length;

  let models = 0;
  try {
    const res = await fetch(`${internalBaseUrl()}/v1/models`, {
      headers: withApiKey({}),
    });
    if (res.ok) {
      const j = await res.json();
      models = (j.data || []).length;
    }
  } catch {
    // Non-fatal
  }

  return c.json({
    status: "online",
    accounts: {
      available,
      total: accounts.length,
      invalid,
      waiting: 0,
    },
    models,
  });
});

// ─── Models ──────────────────────────────────────────────────────────────────

app.get("/api/models", async (c) => {
  const url = internalBaseUrl() + "/v1/models";
  try {
    const upstream = await fetch(url, { headers: withApiKey({}) });
    const j = await upstream.json();
    return c.json(j, upstream.status as ContentfulStatusCode);
  } catch (err) {
    return c.json(
      { data: [], error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

app.get("/api/images/models", async (c) => {
  const url = internalBaseUrl() + "/v1/models";
  const fallback = [
    "qwen-image-max",
    "qwen-image-plus",
    "qwen-image",
    "wan2.6-t2i",
    "wan2.5-t2i-preview",
    "wan2.2-t2i-flash",
  ];
  try {
    const upstream = await fetch(url, { headers: withApiKey({}) });
    if (!upstream.ok) return c.json({ data: fallback.map((id) => ({ id })) });
    const j = await upstream.json();
    const ids = (j.data || [])
      .map((m: { id?: string }) => m.id)
      .filter(
        (id: string) =>
          /(?:image|vl|wan|t2i)/i.test(id) && !id.includes("thinking"),
      );
    return c.json({ data: (ids.length ? ids : fallback).map((id: string) => ({ id })) });
  } catch {
    return c.json({ data: fallback.map((id) => ({ id })) });
  }
});

// ─── Chat / files / media (forwarded to /v1, aspect_ratio → size) ────────────

app.post("/api/chat/completions", (c) => proxyChatCompletions(c));
app.post("/api/v1/chat/completions", (c) => proxyChatCompletions(c));

async function proxyChatCompletions(c: Context): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  return forwardToV1(c, "/v1/chat/completions", body);
}

app.post("/api/files/upload", (c) => proxyUpload(c));

async function proxyUpload(c: Context): Promise<Response> {
  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return c.json({ success: false, error: "Invalid upload" }, 400);
  }

  const url = internalBaseUrl() + "/v1/upload";
  const headers: Record<string, string> = {};
  withApiKey(headers);

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: form,
    });
    const j = await upstream.json();
    return c.json(j, upstream.status as ContentfulStatusCode);
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }
}

function aspectRatioToSize(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

app.post("/api/images/generations", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const size = aspectRatioToSize(body.aspect_ratio);
  const payload = {
    prompt: body.prompt,
    model: body.model,
    n: body.n,
    ...(size ? { size } : {}),
    ...(body.response_format ? { response_format: body.response_format } : {}),
  };
  return forwardToV1(c, "/v1/images/generations", payload);
});

app.post("/api/videos/generations", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const size = aspectRatioToSize(body.aspect_ratio);
  const payload = {
    prompt: body.prompt,
    model: body.model,
    ...(size ? { size } : {}),
    wait: body.wait ?? false,
  };
  return forwardToV1(c, "/v1/videos/generations", payload);
});

app.get("/api/tasks/status/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const wait = c.req.query("wait");
  const qs = wait === "true" ? "?wait=true" : wait === "false" ? "?wait=false" : "";
  return forwardToV1(c, `/v1/tasks/status/${encodeURIComponent(taskId)}${qs}`, undefined, "GET");
});

// ─── Media download proxy (bypass CORS / hotlink protection) ─────────────────

app.get("/api/download", async (c) => {
  const target = c.req.query("url");
  const name = c.req.query("name");
  const inline = c.req.query("inline") === "1";
  if (!target) {
    return c.json({ error: "Missing url parameter" }, 400);
  }

  try {
    const upstream = await fetch(target);
    if (!upstream.ok) {
      return c.text(`Download failed: HTTP ${upstream.status}`, upstream.status as ContentfulStatusCode);
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const disposition = inline ? "inline" : "attachment";

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}${
          name ? `; filename="${encodeURIComponent(name)}"` : ""
        }`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    return c.text(
      `Download proxy error: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
});

export { app };
