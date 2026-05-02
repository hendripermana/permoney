import { expect, test } from "vite-plus/test"
import { hash, type Options } from "@node-rs/argon2"

const argonOpts: Options = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  outputLen: 32, // 32 bytes
  algorithm: 2, // Argon2id
}

test("Argon2id hashing takes between 100ms and 500ms", async () => {
  const password = "testPassword123!@#"

  const start = performance.now()
  await hash(password, argonOpts)
  const end = performance.now()

  const duration = end - start
  console.log(`Argon2id hash took ${duration}ms`)

  expect(duration).toBeGreaterThanOrEqual(100)
  expect(duration).toBeLessThanOrEqual(500)
})
