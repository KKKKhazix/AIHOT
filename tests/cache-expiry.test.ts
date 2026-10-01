// 时间门槛使用可控时钟和promise门闩，不等待真实秒数来掩盖过期结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { cached } from "@aihot/backend/lib/cache";
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(open => { resolve = open; });
  return { promise, resolve };
}

test("绝对截止优先于fresh和stale窗口，并发读共享刷新", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let loads = 0;
  const pending = gate<{ expires: number; value: number }>();
  const cache = cached(async () => ++loads === 1 ? { expires: 2000, value: 1 } : pending.promise,
    { freshMs: 60_000, maxStaleMs: 600_000, expiresAt: value => value.expires });
  assert.equal((await cache.get()).value, 1);
  t.mock.timers.setTime(2000);
  const a = cache.get();
  const b = cache.get();
  assert.equal(loads, 2);
  pending.resolve({ expires: 3000, value: 2 });
  assert.deepEqual(await Promise.all([a, b]), [{ expires: 3000, value: 2 }, { expires: 3000, value: 2 }]);
});

test("发布后加入的读者不会接受发布前仍在途的过期快照", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const pending = gate<{ expires: number; value: number }>();
  let loads = 0;
  const cache = cached(async () => ++loads === 1 ? pending.promise : { expires: 3000, value: 2 },
    { freshMs: 60_000, maxStaleMs: 600_000, expiresAt: value => value.expires });
  const before = cache.get();
  t.mock.timers.setTime(2000);
  const after = cache.get();
  pending.resolve({ expires: 2000, value: 1 });
  await before;
  assert.equal((await after).value, 2);
  assert.equal(loads, 2);
});

test("clear后旧请求的完成不能替换新值或解除新请求的共享", async () => {
  const first = gate<number>();
  const second = gate<number>();
  let loads = 0;
  const cache = cached(() => ++loads === 1 ? first.promise : second.promise, { freshMs: 60_000, maxStaleMs: 600_000 });
  const old = cache.get();
  cache.clear();
  const current = cache.get();
  first.resolve(1);
  assert.equal(await old, 1);
  const shared = cache.get();
  assert.equal(loads, 2);
  second.resolve(2);
  assert.deepEqual(await Promise.all([current, shared, cache.get()]), [2, 2, 2]);
});

test("截止后刷新错误向读者传递，不回退为新鲜旧值", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let loads = 0;
  const cache = cached(async () => { if (++loads > 1) throw new Error("测试数据库失败"); return { expires: 2000 }; },
    { freshMs: 60_000, maxStaleMs: 600_000, expiresAt: value => value.expires });
  await cache.get();
  t.mock.timers.setTime(2000);
  await assert.rejects(cache.get(), /测试数据库失败/);
});


test("没有绝对截止的调用保留原有后台刷新语义", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let loads = 0;
  const cache = cached(async () => ++loads, { freshMs: 1000, maxStaleMs: 10_000 });
  assert.equal(await cache.get(), 1);
  t.mock.timers.setTime(2000);
  assert.equal(await cache.get(), 1, "普通stale窗口仍立即返回旧值");
  assert.equal(await cache.get(), 2);
  assert.equal(loads, 2);
});
