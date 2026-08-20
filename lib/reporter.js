// scraper/lib/reporter.js
const fs = require('fs')
const path = require('path')
const { CONFIG, log } = require('../config')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function nowIso() {
  return new Date().toISOString()
}

function createRunReporter() {
  ensureDir(CONFIG.paths.reportsDir)

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(CONFIG.paths.reportsDir, runId)
  ensureDir(runDir)

  const state = {
    runId,
    startedAt: nowIso(),
    endedAt: null,
    totals: { totalJobs: 0, success: 0, failed: 0, skipped: 0 },
    reasons: {},
    jobs: [],
  }

  const attemptsFile = path.join(runDir, 'attempts.ndjson')
  const summaryFile = path.join(runDir, 'summary.json')
  const latestFile = path.join(CONFIG.paths.reportsDir, 'latest-run.json')

  function bumpReason(reason) {
    const key = reason || 'unknown'
    state.reasons[key] = (state.reasons[key] || 0) + 1
  }

  function appendAttempt(attempt) {
    const row = { time: nowIso(), ...attempt }
    fs.appendFileSync(attemptsFile, JSON.stringify(row, null, 0) + '\n', 'utf8')
  }

  function pushJob(job) {
    state.jobs.push(job)
    state.totals.totalJobs += 1

    if (job.status === 'success') state.totals.success += 1
    else if (job.status === 'skipped') state.totals.skipped += 1
    else {
      state.totals.failed += 1
      bumpReason(job.reason)
    }
  }

  function finish() {
    state.endedAt = nowIso()
    fs.writeFileSync(summaryFile, JSON.stringify(state, null, 2), 'utf8')
    fs.writeFileSync(latestFile, JSON.stringify(state, null, 2), 'utf8')

    log.info(`تقرير التشغيل: ${summaryFile}`)
    log.info(`المحاولات: ${attemptsFile}`)
  }

  return { runId, appendAttempt, pushJob, finish }
}

module.exports = { createRunReporter }
