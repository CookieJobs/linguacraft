// input: node-fetch, nodemailer, dotenv
// output: 调 DeepSeek 用户余额 API, 按阈值告警 (exit 1 / 发邮件 / 静默通过)
// pos: 系统/运维
// 若我被更新, 请同步更新我的开头注释, 以及所属文件夹的 README.
//
// linguacraft DeepSeek 月预算告警脚本
//
// 目的: 1000 学生上线后 DeepSeek API 调用量爆涨, 烧钱失控, 加月预算门禁:
//   - balance < 50 USD → console.error + 进程 exit 1 (CI/CD 部署前必跑, 阻断发布)
//   - balance < 10 USD → 发邮件给 ADMIN_EMAIL (nodemailer, 复用 backend/.env SMTP)
//
// 跑法:
//   cd backend && npx ts-node scripts/check-deepseek-budget.ts
//   cd backend && npx ts-node scripts/check-deepseek-budget.ts --mock-balance=42   # 本地 dry-run, 不调真实 API
//   cd backend && npx ts-node scripts/check-deepseek-budget.ts --skip-email       # 余额低也不发邮件 (调试)
//
// 部署建议:
//   - CI/CD 部署脚本前 (例 GitLab CI deploy job 第一步) 强制跑, exit 1 直接 fail
//   - 系统 cron 每月 1 号 03:00 跑一次月预算巡检 (发邮件提醒管理员手动续费)
//
// 2026-06-12: 首次上线, 三档阈值 (50/10/正常)

import * as dotenv from 'dotenv'
import * as path from 'path'
import fetch from 'node-fetch'
import * as nodemailer from 'nodemailer'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

// ---------- args ----------
function parseArgs() {
  const args = process.argv.slice(2)
  const opts: { mockBalance?: number; skipEmail: boolean } = { skipEmail: false }
  for (const a of args) {
    if (a.startsWith('--mock-balance=')) {
      const v = parseFloat(a.split('=')[1])
      if (!isNaN(v)) opts.mockBalance = v
    } else if (a === '--skip-email') {
      opts.skipEmail = true
    }
  }
  return opts
}

// ---------- 拉余额 ----------
// DeepSeek /user/balance 返回形如: { balance: "42.50", ... }  — balance 是字符串!
interface DeepSeekBalance {
  is_available: boolean
  balance: string
  currency?: string
}

async function fetchBalance(apiKey: string): Promise<number> {
  const res = await fetch('https://api.deepseek.com/user/balance', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DeepSeek /user/balance failed: ${res.status} ${res.statusText} ${text}`)
  }
  const data = (await res.json()) as DeepSeekBalance
  if (!data.is_available) {
    throw new Error(`DeepSeek account unavailable: ${JSON.stringify(data)}`)
  }
  const bal = parseFloat(data.balance)
  if (isNaN(bal)) {
    throw new Error(`Invalid balance value from DeepSeek: ${data.balance}`)
  }
  return bal
}

// ---------- 发邮件 ----------
async function sendAdminEmail(balance: number, smtpConfig: {
  host: string; port: number; user: string; pass: string; from: string
}, to: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.port === 465, // 587 STARTTLS vs 465 implicit
    auth: { user: smtpConfig.user, pass: smtpConfig.pass }
  })

  const subject = `[linguacraft] DeepSeek 余额告警 — 仅剩 $${balance.toFixed(2)}`
  const text = `DeepSeek 账户余额: $${balance.toFixed(2)} USD

已低于 10 USD 阈值, 1000 学生上线后调用量会很快清零。
请尽快充值 DeepSeek 账户 (https://platform.deepseek.com/top_up).

—
自动告警: backend/scripts/check-deepseek-budget.ts
时间: ${new Date().toISOString()}
`

  await transporter.sendMail({ from: smtpConfig.from, to, subject, text })
}

// ---------- main ----------
async function main() {
  const opts = parseArgs()
  let balance: number

  if (opts.mockBalance !== undefined) {
    console.log(`[mock] using mock balance: $${opts.mockBalance}`)
    balance = opts.mockBalance
  } else {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) {
      console.error('DEEPSEEK_API_KEY missing in backend/.env — cannot check balance')
      process.exit(2) // 配置错误, 跟"余额低"区分
    }
    try {
      balance = await fetchBalance(apiKey)
    } catch (e: any) {
      console.error(`[error] ${e.message}`)
      process.exit(2) // 网络/API 错, 也跟"余额低"区分
    }
    console.log(`DeepSeek balance: $${balance.toFixed(4)} USD`)
  }

  // 阈值 1: < 50 → exit 1 (CI/CD 阻断)
  if (balance < 50) {
    console.error(`[FAIL] DeepSeek balance $${balance.toFixed(2)} < $50 threshold`)
    console.error(`       CI/CD 部署应被阻断. 请充值后再发布.`)
    // 阈值 2: < 10 → 发邮件 (10~50 不发, 只阻断)
    if (balance < 10 && !opts.skipEmail) {
      try {
        const adminEmail = process.env.ADMIN_EMAIL
        const smtpHost = process.env.SMTP_HOST
        const smtpUser = process.env.SMTP_USER
        const smtpPass = process.env.SMTP_PASS
        const smtpFrom = process.env.SMTP_FROM
        const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10)
        if (!adminEmail || !smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
          console.error('[email] SMTP / ADMIN_EMAIL config missing in .env — cannot send alert')
        } else {
          await sendAdminEmail(balance, {
            host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, from: smtpFrom
          }, adminEmail)
          console.error(`[email] alert sent to ${adminEmail}`)
        }
      } catch (e: any) {
        console.error(`[email] send failed: ${e.message}`)
        // 邮件失败不阻断 exit, 已经 console.error 了
      }
    } else if (balance < 10 && opts.skipEmail) {
      console.error(`[email] --skip-email flag set, not sending`)
    }
    process.exit(1)
  }

  console.log(`[OK] balance $${balance.toFixed(2)} >= $50 threshold, deploy permitted`)
  process.exit(0)
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`)
  process.exit(2)
})
