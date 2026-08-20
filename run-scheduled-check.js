// scraper/run-scheduled-check.js
// يفحص كل السيرفرات المنتهية بقاعدة البيانات (أفلام + مسلسلات معًا) ويجددها.
require('dotenv').config()
const { log, CONFIG, sortByYear, groupExpiredByTitle } = require('./config')
const { createRunReporter } = require('./lib/reporter')
const { getExpiredServers, refreshTitle, launchMainBrowser } = require('./lib/resolver')

// MAX_RUN_MINUTES: حد زمني اختياري (مهم لما تشغّلها بـGitHub Actions —
// دقائقهم المجانية محدودة، فما تبي تشغيلة وحدة تاكل الميزانية كلها وهي
// تحاول تصلح 20 ألف رابط دفعة وحدة). لو ما انحط، يشتغل لين يخلص الكل.
async function runScheduledCheck({ maxRunMinutes } = {}) {
  const startTime = Date.now()
  const deadline = maxRunMinutes ? startTime + maxRunMinutes * 60 * 1000 : Infinity
  const reporter = createRunReporter()

  log.info('بدء الفحص الذكي...')

  const expiredServers = await getExpiredServers()

  if (!expiredServers.length) {
    reporter.finish()
    log.success('كل الروابط شغالة')
    return
  }

  const groups = groupExpiredByTitle(expiredServers)
  const sorted = sortByYear(groups)

  log.info(`${sorted.length} عنوان يحتاج تحديث${maxRunMinutes ? ` (حد الوقت: ${maxRunMinutes} دقيقة)` : ''}`)

  const browser = await launchMainBrowser()
  let processedCount = 0
  let stoppedEarly = false

  try {
    for (let i = 0; i < sorted.length; i += CONFIG.batchSize) {
      if (Date.now() >= deadline) {
        stoppedEarly = true
        log.warn(`توقفنا عند حد الوقت — ${processedCount}/${sorted.length} تمت معالجتهم، الباقي بالتشغيلة الجاية`)
        break
      }

      const batch = sorted.slice(i, i + CONFIG.batchSize)

      await Promise.all(
        batch.map((g) =>
          refreshTitle(browser, g.title_id, g.episode_id, reporter).catch((e) => {
            reporter.pushJob({
              titleId: g.title_id,
              episodeId: g.episode_id,
              title: g.title?.original_title || 'Unknown',
              year: g.title?.year || null,
              status: 'failed',
              reason: `unexpected_batch_error: ${e.message}`,
              hlsCount: 0,
            })
            log.error(`فشل: ${g.title?.original_title} | ${e.message}`)
          })
        )
      )

      processedCount = Math.min(i + CONFIG.batchSize, sorted.length)
      log.info(`تم ${processedCount}/${sorted.length}`)
    }
  } finally {
    await browser.close()
    reporter.finish()
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log.success(`انتهى في ${elapsed} ثانية${stoppedEarly ? ' (توقف مبكر بسبب حد الوقت)' : ''}`)
}

module.exports = { runScheduledCheck }

if (require.main === module) {
  const maxRunMinutes = process.env.MAX_RUN_MINUTES ? Number(process.env.MAX_RUN_MINUTES) : undefined
  runScheduledCheck({ maxRunMinutes }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
