import fs from "fs"
import path from "path"

/**
 * SECURITY GUARD: check-pre-auth-stub.mjs
 *
 * This script ensures that the pre-auth stub `prisma.user.findFirst()`
 * is not accidentally removed or expanded without explicit intent.
 *
 * EXPECTED BASELINE COUNT: 4
 *
 * When M1 (authentication) lands, this count should become 0 and this
 * script can be safely deleted.
 */

const EXPECTED_COUNT = 4
const SEARCH_PATTERN = /prisma\.user\.findFirst\s*\(/g
const SEARCH_DIR = "src/server"

function countOccurrences(dir) {
  let count = 0
  const files = fs.readdirSync(dir)

  for (const file of files) {
    const fullPath = path.join(dir, file)
    const stat = fs.statSync(fullPath)

    if (stat.isDirectory()) {
      count += countOccurrences(fullPath)
    } else if (
      stat.isFile() &&
      (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx"))
    ) {
      const content = fs.readFileSync(fullPath, "utf8")
      const matches = content.match(SEARCH_PATTERN)
      if (matches) {
        count += matches.length
      }
    }
  }
  return count
}

try {
  const totalCount = countOccurrences(SEARCH_DIR)

  if (totalCount !== EXPECTED_COUNT) {
    console.error(`❌ SECURITY CHECK FAILED: Pre-auth stub count mismatch.`)
    console.error(
      `Expected exactly ${EXPECTED_COUNT} occurrences of 'prisma.user.findFirst(' in ${SEARCH_DIR}/.`
    )
    console.error(`Found ${totalCount}.`)
    console.error(
      `If you removed the auth stub intentionally (M1), update EXPECTED_COUNT in scripts/check-pre-auth-stub.mjs.`
    )
    console.error(`Do NOT add new auth stubs.`)
    process.exit(1)
  } else {
    console.log(
      `✅ SECURITY CHECK PASSED: Pre-auth stub count is ${EXPECTED_COUNT} (Expected).`
    )
    process.exit(0)
  }
} catch (error) {
  console.error(`❌ SECURITY CHECK ERROR: Failed to check files.`)
  console.error(error.message)
  process.exit(1)
}
