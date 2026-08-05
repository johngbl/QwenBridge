import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import {
  acquireAccountLease,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";
import {
  closeIdlePlaywrightAccounts,
  closePlaywrightForAccount,
  getIdlePlaywrightAccountIds,
  isPlaywrightInitialized,
  registerPlaywrightAccountForTests,
} from "../services/playwright.ts";
import {
  isSessionKeeperRunning,
  runSessionKeeperOnceForTesting,
  startSessionKeeper,
  stopSessionKeeper,
} from "../services/session-keeper.ts";

const IDLE_MS = 60_000;
const STALE_ACTIVITY_AT = Date.now() - 10 * 60_000;

/** The idle sweep only needs the page to exist in the account map. */
function stubPage(): any {
  return { isClosed: () => false, url: () => "https://chat.qwen.ai/" };
}

test("session keeper starts and stops safely", () => {
  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);

  startSessionKeeper();
  assert.equal(
    isSessionKeeperRunning(),
    config.sessionKeeper.enabled || config.playwright.idleContextTtlMs > 0,
  );

  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);
});

test("session keeper one-shot cycle is safe without initialized accounts", async () => {
  stopSessionKeeper();
  await runSessionKeeperOnceForTesting();
  assert.equal(isSessionKeeperRunning(), false);
});

test("idle sweep still closes a context with no stream in flight", async () => {
  resetAccountConcurrencyForTests();
  const accountId = "idle-no-lease";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);

  assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), [accountId]);
  assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 1);
  assert.equal(isPlaywrightInitialized(accountId), false);
});

test("idle sweep never closes a context that holds a stream lease", async () => {
  resetAccountConcurrencyForTests();
  const accountId = "idle-with-lease";
  // A browser generation performs no page operation, so its last activity is
  // as old as the request itself — the exact shape of a >TTL generation.
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);
  const lease = await acquireAccountLease(accountId);

  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), []);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    lease.release();
  }

  // The sweep refreshed the idle clock while the stream was alive, so the
  // context is not collectable the moment the lease is released either.
  assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
  assert.equal(isPlaywrightInitialized(accountId), true);

  await closePlaywrightForAccount(accountId);
});
