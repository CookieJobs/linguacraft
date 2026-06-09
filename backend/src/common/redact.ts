// input: 无
// output: redact, redactObject, safeError, safeStringify
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 敏感字段脱敏工具 — 用在所有 console.log/error 输出前,避免泄露 email/token/password
//
// 策略:
//   - 命中规则的对象字段 → 整字段值替换为 '***'
//   - 命中规则的字符串内嵌 → 整字符串替换为 '***'
//   - 默认覆盖最常见的:password / token / accessToken / refreshToken / jwt /
//     authorization / cookie / set-cookie / secret / apiKey / api_key
//   - email 字段做局部脱敏:j***@example.com (保留前 1 位 + 域名)
//
// 用法:
//   import { safeError } from '../../common/redact'
//   catch (e) { console.error('Failed:', safeError(e)) }

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd',
  'token', 'accesstoken', 'refreshtoken', 'jwt', 'jti',
  'authorization', 'cookie', 'set-cookie', 'setcookie',
  'secret', 'apikey', 'api_key',
  'code',  // 验证码也算
  'smtppass', 'smtp_pass', 'smtpuser', 'smtp_user',
  'privatekey', 'private_key'
])

const EMAIL_KEYS = new Set(['email', 'mail', 'useremail'])

const MAX_DEPTH = 6
const MAX_STRING = 500
const MAX_KEYS = 50

function isPlainObject(v: any): boolean {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * 深度遍历对象,把所有"敏感字段"的值替换成 ***。
 * 数组/对象/基本类型都能处理,内部会防爆栈。
 */
export function redact<T>(value: T): T {
  return _redact(value, 0, new WeakSet()) as T
}

function _redact(value: any, depth: number, seen: WeakSet<object>): any {
  if (depth > MAX_DEPTH) return '***'
  if (value === null || value === undefined) return value
  const t = typeof value

  if (t === 'string') {
    const s = value as string
    if (s.length > MAX_STRING) return s.slice(0, MAX_STRING) + '...[truncated]'
    // 内嵌 email 模式也脱敏(防止 error message 里有 user@example.com)
    return redactEmailsInString(s)
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value
  if (t === 'function' || t === 'symbol') return String(value)

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((v) => _redact(v, depth + 1, seen))
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, any> = {}
    const keys = Object.keys(value).slice(0, MAX_KEYS)
    for (const k of keys) {
      const lower = k.toLowerCase()
      if (SENSITIVE_KEYS.has(lower)) {
        out[k] = '***'
      } else if (EMAIL_KEYS.has(lower) && typeof value[k] === 'string') {
        out[k] = redactEmail(value[k])
      } else {
        out[k] = _redact(value[k], depth + 1, seen)
      }
    }
    return out
  }

  // 其它类型 (Buffer, Date, Error, etc.)
  return value
}

/**
 * 把 "user@example.com" → "u***@example.com"
 * 非 email 格式原样返回
 */
export function redactEmail(s: string): string {
  if (typeof s !== 'string') return s
  const at = s.indexOf('@')
  if (at <= 0 || at === s.length - 1) return s
  const user = s.slice(0, at)
  const domain = s.slice(at + 1)
  const head = user.slice(0, 1) || '*'
  return `${head}***@${domain}`
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// 常见内嵌敏感模式 — 用在字符串里再兜一层
// 注意:这些 regex 故意保守(只匹配紧跟 "key=value" 或 "key: value" 形式),避免误杀
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g
const KVPASS_REGEX = /\b(password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*['"]?([^\s'"&;,]{4,})['"]?/gi

/**
 * 在任意字符串内,把出现的 email / Bearer / key=secret 模式脱敏
 * "failed to login john@example.com with password=Hello123" → "failed to login j***@example.com with password=***"
 * "Authorization: Bearer eyJhbGciOiJI..." → "Authorization: Bearer ***"
 */
function redactEmailsInString(s: string): string {
  if (s.indexOf('@') === -1 && !/Bearer\s/i.test(s) && !KVPASS_REGEX.test(s)) {
    return s // 快速路径
  }
  let out = s
  out = out.replace(EMAIL_REGEX, (m) => redactEmail(m))
  out = out.replace(BEARER_REGEX, 'Bearer ***')
  out = out.replace(KVPASS_REGEX, (_m, key) => `${key}=***`)
  return out
}

/**
 * 专门给 console.error 用的 — 把 Error 对象的 message / stack 里的敏感信息也脱敏
 * Error.stack 里的字段名通常以 `at: xxx` 开头,不会泄露 secrets;
 * 但 message 经常包含请求 body / 错误响应,需要 redact
 */
export function safeError(e: any): any {
  if (e === null || e === undefined) return e
  if (e instanceof Error) {
    // stack 截断前 800 字符后再跑内嵌脱敏(防止 stack 里出现 email/Bearer 原文)
    const rawStack = typeof e.stack === 'string' ? e.stack.slice(0, 800) : undefined
    return {
      name: e.name,
      message: redact(e.message),
      stack: rawStack ? (typeof rawStack === 'string' ? redactEmailsInString(rawStack) : rawStack) : undefined,
      // 其它自定义字段
      ...redrawExtra(e)
    }
  }
  return redact(e)
}

function redrawExtra(e: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const k of Object.keys(e)) {
    if (k === 'message' || k === 'stack' || k === 'name') continue
    out[k] = redact((e as any)[k])
  }
  return out
}

/**
 * JSON.stringify + redact 一把梭,任何 console.log 输出的对象都该走这个
 */
export function safeStringify(value: any, indent = 2): string {
  return JSON.stringify(redact(value), null, indent)
}
