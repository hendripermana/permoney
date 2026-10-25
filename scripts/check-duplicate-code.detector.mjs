/**
 * check-duplicate-code.detector.mjs — pure, IO-free decision logic for the
 * jscpd duplication guard in `scripts/check-duplicate-code.mjs`.
 *
 * This module owns the policy that must be pinned by tests:
 *
 *   • config validation      — the committed `scripts/jscpd.config.json` is the
 *                              only scan policy; unknown or missing keys are a
 *                              hard error so a typo cannot silently widen the
 *                              scan while the baseline keeps passing;
 *   • auto-config detection  — jscpd 5 auto-discovers `.jscpd.json`,
 *                              `.config/jscpd.json` and `package.json#jscpd`.
 *                              Any of those existing is a conflict: the guard
 *                              must be the only thing that decides scope;
 *   • report-contract        — rejects unreadable/truncated JSON, a report with
 *                              zero analyzed sources, a `duplicates` array that
 *                              disagrees with `statistics.total.clones`, and an
 *                              `isNew` tally that disagrees with
 *                              `statistics.total.newClones`. These are
 *                              same-process consistency checks on ONE jscpd
 *                              report — they are NOT independent validation of
 *                              jscpd's detection, and this module never claims
 *                              they are;
 *   • baseline-contract      — validates the committed fingerprint baseline
 *                              (`version: 1`, hex fingerprints, positive
 *                              multiplicities);
 *   • comparison             — decides pass/fail from the report and the
 *                              source-count anchor;
 *   • diagnostics selection  — selects EVERY entry the report marks `isNew`
 *                              (never a top-N sample) and formats it so the
 *                              failure names the actual offending clone.
 *
 * No `fs`, no `process`, no `console`: the CLI shim reads files and spawns
 * jscpd, then hands strings to these functions. That separation is what makes
 * the failure contract testable in `check-duplicate-code.test.mjs`.
 */

/** New clone fingerprints this gate tolerates. Zero: the whole point. */
export const ALLOWED_NEW_CLONES = 0

/** Exact keys allowed in `scripts/jscpd.config.json`. */
const CONFIG_KEYS = [
  "format",
  "ignore",
  "minLines",
  "minTokens",
  "mode",
  "pattern",
]

const DETECTION_MODES = ["mild", "weak", "strict"]

/** Error type the CLI distinguishes from a crash for concise output. */
export class GuardError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = "GuardError"
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate the committed jscpd config and return a frozen copy with only the
 * policy keys. Strict on purpose: jscpd silently ignores unknown keys, so a
 * misspelled `minToken` would otherwise widen the scan without a trace.
 *
 * @param {unknown} raw parsed JSON from `scripts/jscpd.config.json`
 * @returns {Readonly<{
 *   minTokens: number,
 *   minLines: number,
 *   mode: "mild" | "weak" | "strict",
 *   format: string[],
 *   pattern: string,
 *   ignore: string[],
 * }>}
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new GuardError("jscpd config must be a JSON object.")
  }

  const present = Object.keys(raw)
  const unknown = present.filter((key) => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new GuardError(
      `jscpd config has unknown key(s): ${unknown.join(", ")}. ` +
        `Allowed keys: ${CONFIG_KEYS.join(", ")}. ` +
        "jscpd ignores unknown keys, so this would silently move the gate."
    )
  }

  const missing = CONFIG_KEYS.filter((key) => !present.includes(key))
  if (missing.length > 0) {
    throw new GuardError(
      `jscpd config is missing key(s): ${missing.join(", ")}. ` +
        "Every scan-policy key must be explicit; defaults are not part of the baseline."
    )
  }

  if (!Number.isInteger(raw.minTokens) || raw.minTokens <= 0) {
    throw new GuardError("jscpd config minTokens must be a positive integer.")
  }
  if (!Number.isInteger(raw.minLines) || raw.minLines <= 0) {
    throw new GuardError("jscpd config minLines must be a positive integer.")
  }
  if (!DETECTION_MODES.includes(raw.mode)) {
    throw new GuardError(
      `jscpd config mode must be one of: ${DETECTION_MODES.join(", ")} (got ${JSON.stringify(raw.mode)}).`
    )
  }
  if (
    !Array.isArray(raw.format) ||
    raw.format.length === 0 ||
    raw.format.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new GuardError(
      "jscpd config format must be a non-empty array of non-empty strings."
    )
  }
  if (typeof raw.pattern !== "string" || raw.pattern.trim() === "") {
    throw new GuardError("jscpd config pattern must be a non-empty string.")
  }
  if (
    !Array.isArray(raw.ignore) ||
    raw.ignore.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new GuardError("jscpd config ignore must be an array of strings.")
  }

  return Object.freeze({
    minTokens: raw.minTokens,
    minLines: raw.minLines,
    mode: raw.mode,
    format: Object.freeze([...raw.format]),
    pattern: raw.pattern,
    ignore: Object.freeze([...raw.ignore]),
  })
}

/**
 * jscpd 5 auto-discovers these files in the working directory. Any of them
 * existing is a hard failure: the committed config must be the only source of
 * truth, otherwise a local file can move the gate without touching the repo.
 *
 * @param {{ rootConfig: boolean, nestedConfig: boolean, packageJson: boolean }} sources
 * @returns {string | null} actionable message, or null when clean
 */
export function describeAutoConfigConflict({
  rootConfig,
  nestedConfig,
  packageJson,
}) {
  const found = []
  if (rootConfig) found.push(".jscpd.json")
  if (nestedConfig) found.push(".config/jscpd.json")
  if (packageJson) found.push('package.json "jscpd" key')

  if (found.length === 0) {
    return null
  }

  return [
    `jscpd auto-discovers config from ${found.join(", ")}.`,
    "This guard passes `--config scripts/jscpd.config.json` explicitly so the committed policy is the only thing that decides scope.",
    `Remove ${found.join(", ")} (or fold its settings into scripts/jscpd.config.json) before re-running.`,
  ].join(" ")
}

/**
 * Parse and validate a jscpd JSON report. Every rejection is fail-closed: an
 * unreadable report, an empty scan, or an internally inconsistent count must
 * never look like "0 clones, pass".
 *
 * @param {string} text raw contents of `jscpd-report.json`
 * @returns {{
 *   cloneCount: number,
 *   newCloneCount: number,
 *   sources: number,
 *   duplicates: Array<{
 *     lines: number,
 *     tokens: number,
 *     isNew: boolean,
 *     firstFile: { name: string, start: number, end: number },
 *     secondFile: { name: string, start: number, end: number },
 *   }>,
 * }}
 */
export function parseReport(text) {
  let report
  try {
    report = JSON.parse(text)
  } catch (error) {
    throw new GuardError(
      `jscpd report is not readable JSON: ${error.message}. ` +
        "The report was not produced or was truncated; refusing to guess."
    )
  }

  const total = report?.statistics?.total
  if (!isPlainObject(total)) {
    throw new GuardError(
      "jscpd's JSON report has no statistics.total object; the report contract changed."
    )
  }

  const { clones, newClones, sources } = total
  if (!Number.isInteger(clones) || clones < 0) {
    throw new GuardError(
      "jscpd's JSON report has no integer statistics.total.clones; the report contract changed."
    )
  }
  if (!Number.isInteger(newClones) || newClones < 0) {
    throw new GuardError(
      "jscpd's JSON report has no integer statistics.total.newClones; " +
        "this guard requires jscpd 5.4.2 fingerprint baselines. " +
        "If jscpd changed, deliberately re-measure the baseline before adopting the new engine."
    )
  }
  if (!Number.isInteger(sources) || sources <= 0) {
    throw new GuardError(
      "jscpd analyzed zero source files. Check PATH_PATTERN/FORMATS/IGNORES " +
        "(and scripts/jscpd.config.json) — an empty scan must not pass."
    )
  }
  if (!Array.isArray(report.duplicates)) {
    throw new GuardError(
      "jscpd's JSON report has no duplicates array; the report contract changed."
    )
  }
  if (report.duplicates.length !== clones) {
    throw new GuardError(
      `jscpd report is inconsistent: statistics.total.clones=${clones} but ` +
        `duplicates.length=${report.duplicates.length}. Refusing to compare an unreliable report.`
    )
  }

  const duplicates = report.duplicates.map((duplicate, index) =>
    validateDuplicate(duplicate, index)
  )
  const flaggedNew = duplicates.filter((duplicate) => duplicate.isNew).length
  if (flaggedNew !== newClones) {
    throw new GuardError(
      `jscpd report is inconsistent: statistics.total.newClones=${newClones} but ` +
        `${flaggedNew} duplicate(s) are marked isNew. Refusing to report the wrong clone.`
    )
  }

  return {
    cloneCount: clones,
    newCloneCount: newClones,
    sources,
    duplicates,
  }
}

/**
 * Validate one duplicate entry. The location fields are the payload a failure
 * message prints, so a malformed entry must fail closed rather than produce a
 * misleading path.
 *
 * @param {unknown} duplicate
 * @param {number} index
 */
function validateDuplicate(duplicate, index) {
  const at = `duplicates[${index}]`
  if (!isPlainObject(duplicate)) {
    throw new GuardError(`${at} is not an object; the report contract changed.`)
  }
  if (typeof duplicate.isNew !== "boolean") {
    throw new GuardError(
      `${at}.isNew is missing or not a boolean; the report contract changed. ` +
        "This guard relies on jscpd 5.4.2 marking baseline-absent clones isNew:true."
    )
  }
  if (!Number.isInteger(duplicate.lines) || duplicate.lines <= 0) {
    throw new GuardError(`${at}.lines is missing or invalid.`)
  }
  if (!Number.isInteger(duplicate.tokens) || duplicate.tokens <= 0) {
    throw new GuardError(`${at}.tokens is missing or invalid.`)
  }

  for (const side of ["firstFile", "secondFile"]) {
    const file = duplicate[side]
    if (
      !isPlainObject(file) ||
      typeof file.name !== "string" ||
      file.name === "" ||
      !Number.isInteger(file.start) ||
      !Number.isInteger(file.end) ||
      file.start <= 0 ||
      file.end < file.start
    ) {
      throw new GuardError(
        `${at}.${side} must be { name, start, end } with a positive line range.`
      )
    }
  }

  return duplicate
}

/**
 * Validate the committed fingerprint baseline. The file is generated by
 * `jscpd --update-baseline`; hand-editing it is never the ratchet procedure.
 *
 * @param {string} text raw contents of `scripts/jscpd-baseline.json`
 * @returns {{ version: 1, fingerprints: Record<string, number>, cloneCount: number }}
 */
export function parseBaseline(text) {
  let baseline
  try {
    baseline = JSON.parse(text)
  } catch (error) {
    throw new GuardError(
      `jscpd baseline is not readable JSON: ${error.message}. ` +
        "Restore it from git, or regenerate it deliberately with --update-baseline."
    )
  }

  if (!isPlainObject(baseline)) {
    throw new GuardError("jscpd baseline must be a JSON object.")
  }
  if (baseline.version !== 1) {
    throw new GuardError(
      `jscpd baseline version is ${JSON.stringify(baseline.version)}, expected 1. ` +
        "This guard is pinned to jscpd 5.4.2; re-measure deliberately before adopting a new baseline format."
    )
  }
  if (!isPlainObject(baseline.fingerprints)) {
    throw new GuardError("jscpd baseline has no fingerprints object.")
  }

  let cloneCount = 0
  for (const [fingerprint, count] of Object.entries(baseline.fingerprints)) {
    if (!/^[0-9a-f]+$/i.test(fingerprint)) {
      throw new GuardError(
        `jscpd baseline fingerprint ${JSON.stringify(fingerprint)} is not hex.`
      )
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new GuardError(
        `jscpd baseline fingerprint ${fingerprint} has a non-positive multiplicity.`
      )
    }
    cloneCount += count
  }

  return {
    version: 1,
    fingerprints: Object.freeze({ ...baseline.fingerprints }),
    cloneCount,
  }
}

/**
 * Every entry the report marks `isNew`, largest first. Never truncated: the
 * whole reason this guard exists is to name the clone that caused the failure,
 * and a small 10–15-line clone never reaches a "top 10 by size" table.
 *
 * @param {ReturnType<typeof parseReport>["duplicates"]} duplicates
 */
export function selectNewDuplicates(duplicates) {
  return duplicates
    .filter((duplicate) => duplicate.isNew === true)
    .sort(
      (left, right) =>
        right.lines - left.lines ||
        right.tokens - left.tokens ||
        left.firstFile.name.localeCompare(right.firstFile.name) ||
        left.firstFile.start - right.firstFile.start ||
        left.secondFile.name.localeCompare(right.secondFile.name) ||
        left.secondFile.start - right.secondFile.start
    )
}

/**
 * Compare the report to the committed baseline and the source-count floor.
 *
 * The fingerprint baseline is the gate: a clone whose fingerprint is absent
 * from the baseline (or whose multiplicity exceeds it) is new and fails,
 * regardless of the total clone count. `cloneCount > baselineClones` is a
 * secondary consistency failure — it should be unreachable when the baseline
 * and BASELINE_CLONES are in sync, and it prevents a hand-edited/stale baseline
 * from silently widening the gate.
 *
 * Ratchet advice is offered only when the analyzer saw at least the baseline
 * number of sources. With fewer sources the tree may be partially checked out,
 * so "you removed duplication" is not a safe conclusion.
 *
 * @param {{
 *   report: ReturnType<typeof parseReport>,
 *   baselineClones: number,
 *   baselineSources: number,
 *   allowedNewClones?: number,
 * }} input
 */
export function evaluateGuardResult({
  report,
  baselineClones,
  baselineSources,
  allowedNewClones = ALLOWED_NEW_CLONES,
}) {
  const newDuplicates = selectNewDuplicates(report.duplicates)
  const sourceFloorMet = report.sources >= baselineSources
  const sourceDrift =
    report.sources === baselineSources
      ? null
      : {
          baseline: baselineSources,
          current: report.sources,
          direction: report.sources < baselineSources ? "shrank" : "grew",
        }

  /** @type {null | { code: "new-clones" | "clone-count", newDuplicates: typeof newDuplicates }} */
  let failure = null
  if (report.newCloneCount > allowedNewClones) {
    failure = { code: "new-clones", newDuplicates }
  } else if (report.cloneCount > baselineClones) {
    failure = { code: "clone-count", newDuplicates: [] }
  }

  return {
    ok: failure === null,
    failure,
    newDuplicates,
    sourceFloorMet,
    sourceDrift,
    ratchet: sourceFloorMet && report.cloneCount < baselineClones,
  }
}

/**
 * Human-readable `path:start-end` location.
 *
 * @param {{ name: string, start: number, end: number }} file
 */
export function formatLocation(file) {
  return `${file.name}:${file.start}-${file.end}`
}

/**
 * Render EVERY new duplicate, one block per entry. Callers pass the result of
 * `selectNewDuplicates`, so the output names the offending clone instead of a
 * sample dominated by large pre-existing clones.
 *
 * @param {ReturnType<typeof selectNewDuplicates>} duplicates
 */
export function formatNewDuplicates(duplicates) {
  return duplicates
    .map((duplicate, index) => {
      const rank = String(index + 1).padStart(2)
      return [
        `  ${rank}. ${duplicate.lines} lines / ${duplicate.tokens} tokens  [new]`,
        `      ${formatLocation(duplicate.firstFile)}  <->  ${formatLocation(duplicate.secondFile)}`,
      ].join("\n")
    })
    .join("\n")
}
