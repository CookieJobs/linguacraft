/**
 * Jest config for backend smoke test.
 *
 * - preset ts-jest: 跑 .ts 测试, 用项目的 tsconfig.json 编译
 * - testMatch: 只跑 src/__tests__/ 下文件
 * - testEnvironment node: 跑在 Node 上 (不是 jsdom)
 * - testTimeout 60s: 包含 NestJS app init + Mongo seed + HTTP 请求, 默认 5s 不够
 * - forceExit: 关 app 时 ioredis / mongoose 句柄可能挂住, jest 等不到
 *
 * 2026-06-12 新增: 上线前 smoke test, 不替换 unit test (那部分靠 vitest + e2e 补)
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  testTimeout: 60000,
  forceExit: true,
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  }
}
