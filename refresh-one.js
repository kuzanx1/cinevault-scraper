// scraper/refresh-one.js
// يحدث عنوان/حلقة وحدة بس — يشغّله workflow_dispatch لما زائر حقيقي
// يحتاج رابط معين، بدل مسح القاعدة كلها. أسرع وأرخص بكثير من الفحص الشامل.
require('dotenv').config()
const { launchMainBrowser, refreshTitle } = require('./lib/resolver')
const { log } = require('./config')

async function main() {
  const titleId = process.env.TITLE_ID || process.argv[2]
  const episodeId = process.env.EPISODE_ID || process.argv[3] || null

  if (!titleId) {
    console.error('❌ محتاج TITLE_ID (env) أو كـ argument أول')
    process.exit(1)
  }

  log.info(`تحديث مستهدف: title=${titleId} episode=${episodeId || '(بدون)'}`)

  const browser = await launchMainBrowser()
  try {
    const result = await refreshTitle(browser, titleId, episodeId)
    console.log('RESULT:', JSON.stringify(result))
    if (result.status === 'failed') process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
