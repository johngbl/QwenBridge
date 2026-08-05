import { Hono, type Context } from "hono";
import { config } from "../core/config.js";
import { maskEmail } from "../core/logger.js";
import {
  addAccount,
  removeAccount,
  listAccounts,
  getAccountCredentials,
  updateAccountPassword,
  updateAccountLabel,
} from "../core/accounts.js";
import {
  initPlaywrightForAccount,
  isPlaywrightInitialized,
  closePlaywrightForAccount,
  getPlaywrightStatus,
} from "../services/playwright.js";
import {
  getAccountCooldownInfo,
  clearAccountCooldown,
} from "../core/account-manager.js";
import { createError } from "./error-helpers.js";

const app = new Hono();

interface AddAccountRequest {
  email?: unknown;
  password?: unknown;
}

interface UpdateAccountRequest {
  password?: unknown;
}

function readJson(c: Context): Promise<Record<string, unknown>> {
  return c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}));
}

function accountStatus(accountId: string) {
  const cooldown = getAccountCooldownInfo(accountId);
  const status = getPlaywrightStatus()[accountId];
  return {
    onCooldown: Boolean(cooldown),
    cooldownUntil: cooldown
      ? Date.now() + (cooldown.remainingMs ?? 0)
      : undefined,
    cooldownRemainingMs: cooldown?.remainingMs ?? undefined,
    cooldownReason: cooldown?.reason ?? undefined,
    initialized: Boolean(status?.initialized),
    hasHeaders: Boolean(status?.hasHeaders),
    ready: Boolean(
      status?.initialized &&
        status?.hasHeaders &&
        !cooldown &&
        isPlaywrightInitialized(accountId),
    ),
  };
}

// List accounts with status (never exposes passwords)
app.get("/api/accounts", async (c) => {
  const accounts = listAccounts();
  const accountsWithStatus = accounts.map((account) => ({
    id: account.id,
    email: maskEmail(account.email),
    label: account.label ?? undefined,
    ...accountStatus(account.id),
  }));
  return c.json({ accounts: accountsWithStatus });
});

// Add an account (email/password). Credentials are validated lazily on check.
app.post("/api/accounts", async (c) => {
  const body = await readJson(c) as AddAccountRequest;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return c.json(
      { ok: false, error: "Email and password are required" },
      400,
    );
  }

  try {
    const account = addAccount(email, password);
    return c.json({
      ok: true,
      id: account.id,
      email: maskEmail(account.email),
    });
  } catch (err: unknown) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
});

// Remove an account (and close its Playwright context/profile)
app.delete("/api/accounts/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ ok: false, error: "Missing account id" }, 400);

  try {
    await closePlaywrightForAccount(id).catch(() => {});
  } catch {
    // Ignore close errors — deletion proceeds regardless.
  }

  const removed = removeAccount(id);
  if (!removed) {
    return c.json({ ok: false, error: "Account not found" }, 404);
  }
  return c.json({ ok: true, id });
});

// Validate an account in real time: launches Playwright, logs in (API then UI
// fallback), navigates to Qwen and captures bx-ua/bx-umidtoken headers.
// This is the same flow `npm run login` + server start uses.
app.post("/api/accounts/:id/check", async (c) => {
  const id = c.req.param("id");
  const credentials = getAccountCredentials(id);
  if (!credentials) {
    return c.json({ ok: false, error: "Account not found" }, 404);
  }

  if (isPlaywrightInitialized(id)) {
    await closePlaywrightForAccount(id).catch(() => {});
  }

  try {
    await initPlaywrightForAccount(
      credentials,
      config.playwright.headless,
      config.playwright.browser,
    );
    return c.json({ ok: true, id, ...accountStatus(id) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Ensure a failed check does not leave a stale context behind.
    await closePlaywrightForAccount(id).catch(() => {});
    return c.json({ ok: false, id, error: message, ...accountStatus(id) }, 200);
  }
});

// Update the password for an account (no validation here; use /check after).
app.post("/api/accounts/:id/update", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c) as UpdateAccountRequest;
  const password = typeof body.password === "string" ? body.password : "";

  if (!password) {
    return c.json({ ok: false, error: "Password is required" }, 400);
  }

  try {
    const updated = updateAccountPassword(id, password);
    if (!updated) {
      return c.json({ ok: false, error: "Account not found" }, 404);
    }
    // Invalidate the stored session so the next check re-logs-in.
    await closePlaywrightForAccount(id).catch(() => {});
    return c.json({ ok: true, id });
  } catch (err: unknown) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
});

// Clear a cooldown without re-validating the account.
app.post("/api/accounts/:id/reset-cooldown", async (c) => {
  const id = c.req.param("id");
  const credentials = getAccountCredentials(id);
  if (!credentials) {
    return c.json({ ok: false, error: "Account not found" }, 404);
  }
  clearAccountCooldown(id);
  return c.json({ ok: true, id, ...accountStatus(id) });
});

// Set a human-friendly label for an account.
app.post("/api/accounts/:id/label", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c) as { label?: unknown };
  const label = typeof body.label === "string" ? body.label : "";

  const updated = updateAccountLabel(id, label);
  if (!updated) {
    return c.json({ ok: false, error: "Account not found" }, 404);
  }
  return c.json({ ok: true, id, label: label.trim() });
});

app.onError((err, c) => {
  return c.json(
    {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    },
    createError(500, "Internal error").statusCode,
  );
});

export { app };
