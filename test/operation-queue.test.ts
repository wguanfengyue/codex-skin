import assert from "node:assert/strict"

import { test } from "vitest"

import { createOperationQueue } from "../src/core/operation-queue.ts"
import { mutateSettings } from "../src/runtime/settings-mutations.ts"

test("mutation queue preserves order and recovers after a rejected operation", async () => {
  const enqueue = createOperationQueue()
  const order: number[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = enqueue(async () => {
    order.push(1)
    await gate
    throw new Error("expected")
  })
  const failure = assert.rejects(first, /expected/)
  const second = enqueue(async () => {
    order.push(2)
    return 2
  })
  await Promise.resolve()
  assert.deepEqual(order, [1])
  release()
  await failure
  assert.equal(await second, 2)
  assert.deepEqual(order, [1, 2])
})
test("HTTP mutations share a queue by data directory while independent directories do not block", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const order: string[] = []
  const a = mutateSettings({ dataDirectory: "/fixture/one" }, async () => {
    order.push("a")
    await gate
  })
  const b = mutateSettings({ dataDirectory: "/fixture/one" }, async () => {
    order.push("b")
  })
  await mutateSettings({ dataDirectory: "/fixture/two" }, async () => {
    order.push("c")
  })
  assert.deepEqual(order, ["a", "c"])
  release()
  await Promise.all([a, b])
  assert.deepEqual(order, ["a", "c", "b"])
})
