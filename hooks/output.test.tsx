import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { normalizeMiss } from './core'

// 下层的 hook 代表引擎：CommandOutput 画成一行 Text，内容就是传下来的 props.text。
function engine(on: On) {
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

async function drawn(
  $: Engine,
  text: string,
  extra: { command?: string; isErrored?: boolean; requestId?: string } = {},
) {
  const ui = await $.ui.mount({
    plugin: 'cmd-i18n',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: extra.requestId ?? 'row-1',
    props: { command: extra.command ?? 'compact', args: '', text, isErrored: extra.isErrored ?? false },
  })
  const row = await ui.find({ type: 'Text' })
  await ui.unmount()
  return row?.text
}

test('整段命中词典：输出行显示中文', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await drawn($, 'Compaction canceled.')).toBe('压缩已取消。')
})

test('模板命中：挖空处是不含空白的值', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await drawn($, 'Kept effort level as high', { command: 'effort' })).toBe('思考强度保持为 high')
})

test('多行：命中的行翻译，没命中的行保持英文，列表符号保留', async ($, on) => {
  mock.store(on)
  engine(on)
  const text = '- Enabled plan mode\n- Frobnicated 3 widgets'
  expect(await drawn($, text, { command: 'plan' })).toBe('- 已启用计划模式\n- Frobnicated 3 widgets')
})

test('严格模板：挖空捕获含空白且字面量不足一半时不套用', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await drawn($, 'Compacted. 2 pending')).toBe('Compacted. 2 pending')
})

test('出错行、已是中文、关闭开关时原样显示', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await drawn($, 'Compaction canceled.', { isErrored: true })).toBe('Compaction canceled.')
  expect(await drawn($, '已经是中文', { requestId: 'row-2' })).toBe('已经是中文')
})

test('关闭开关后输出保持英文', async ($, on) => {
  mock.store(on, { enabled: false })
  engine(on)
  expect(await drawn($, 'Compaction canceled.')).toBe('Compaction canceled.')
})

test('/i18n status 统计命令输出命中与常见未命中', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)
  on('command.register', () => ({ value: { command: 'i18n' } }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await drawn($, 'Compaction canceled.', { requestId: 'a' })
  await drawn($, 'Frobnicated 3 widgets', { command: 'foo', requestId: 'b' })
  await drawn($, 'Frobnicated 7 widgets', { command: 'foo', requestId: 'c' })
  // 同一个输出行重画不重复计数
  await drawn($, 'Frobnicated 7 widgets', { command: 'foo', requestId: 'c' })

  const { text } = await $.command.run({
    command: 'i18n',
    args: 'status',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(text).toContain('本会话 3 条，整段翻译 1、部分翻译 0、未命中 2')
  expect(text).toContain('/foo  Frobnicated # widgets  ×2')
})

test('normalizeMiss：数字归一、压缩空白、截断', () => {
  expect(normalizeMiss('  Compacted   12,345 tokens ')).toBe('Compacted #,# tokens')
  expect(normalizeMiss('x'.repeat(100)).length).toBe(80)
})
