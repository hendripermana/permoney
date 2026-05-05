import { expect, test } from "vite-plus/test"
import { hash, verify, type Options } from "@node-rs/argon2"

const argonOpts: Options = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
  outputLen: 32, // 32 bytes
  algorithm: 2, // Argon2id
}

test("Argon2id hash can be verified correctly", async () => {
  const password = "testPassword123!@#"

  const passwordHash = await hash(password, argonOpts)
  expect(passwordHash).toBeTruthy()
  expect(passwordHash.length).toBeGreaterThan(0)

  const isValid = await verify(passwordHash, password)
  expect(isValid).toBe(true)

  const isInvalid = await verify(passwordHash, "wrongPassword")
  expect(isInvalid).toBe(false)
})
