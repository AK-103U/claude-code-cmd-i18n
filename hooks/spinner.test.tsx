import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { compileTemplates, pickByHash, translateStatus } from './core'
import type { Sources } from './core'
import { DICT } from './dict'
import { DONE_VERBS, SPINNER_VERBS } from './verbs'

// 下层的 hook 代表引擎：Spinner 画 "message 或 word" + suffix；TurnDuration 画 "word for 时长"。
function engine(on: On) {
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.message ?? e.props.word}${e.props.suffix}`}</Text>
  })
  on('ui.render', { component: 'TurnDuration' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.word} for ${e.props.durationMs}ms`}</Text>
  })
}

async function spinner(
  $: Engine,
  props: { word?: string; message?: string | null; suffix?: string },
  surface: 'terminal' | 'desktop' = 'terminal',
) {
  const ui = await $.ui.mount({
    plugin: 'cmd-i18n',
    surface,
    component: 'Spinner',
    requestId: 'spinner',
    props: {
      word: props.word ?? 'Sauteing',
      message: props.message ?? null,
      suffix: props.suffix ?? '…',
      mode: 'requesting',
    },
  })
  const row = await ui.find({ type: 'Text' })
  await ui.unmount()
  return row?.text
}

async function turnDuration($: Engine, word: string) {
  const ui = await $.ui.mount({
    plugin: 'cmd-i18n',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'turn-1',
    props: { word, durationMs: 3000 },
  })
  const row = await ui.find({ type: 'Text' })
  await ui.unmount()
  return row?.text
}

test('状态文字：带省略号、不带省略号（引擎补）都能命中，不会画出两个省略号', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await spinner($, { message: 'Compacting conversation…', suffix: '' })).toBe('压缩对话中…')
  expect(await spinner($, { message: 'Compacting conversation', suffix: '…' })).toBe('正在压缩对话…')
  // 词典里只有 "Retrying…"：去掉译文的省略号，由引擎的 suffix 补
  expect(await spinner($, { message: 'Retrying', suffix: '…' })).toBe('重试中…')
  expect(await spinner($, { message: 'Loading marketplaces...', suffix: '' })).toBe('正在加载插件市场...')
})

test('状态文字没命中时保持英文', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await spinner($, { message: 'Frobnicating widgets', suffix: '…' })).toBe('Frobnicating widgets…')
})

test('终端上的英文动词换成自带中文动词，同一个词每次都一样', async ($, on) => {
  mock.store(on)
  engine(on)
  const first = await spinner($, { word: 'Sauteing' })
  const again = await spinner($, { word: 'Sauteing' })
  expect(first).toBe(again)
  expect(SPINNER_VERBS.map(v => `${v}…`)).toContain(first)
})

test('已经是中文的动词、desktop 的步骤说明保持原样', async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await spinner($, { word: '琢磨中' })).toBe('琢磨中…')
  expect(await spinner($, { word: 'Creating notes.md' }, 'desktop')).toBe('Creating notes.md…')
})

test('回合结束：英文过去式换成中文，中文原样', async ($, on) => {
  mock.store(on)
  engine(on)
  const zh = await turnDuration($, 'Baked')
  expect(DONE_VERBS.map(v => `${v} for 3000ms`)).toContain(zh)
  expect(await turnDuration($, '烤了')).toBe('烤了 for 3000ms')
})

test('关闭开关后等待界面保持英文', async ($, on) => {
  mock.store(on, { enabled: false })
  engine(on)
  expect(await spinner($, { word: 'Sauteing' })).toBe('Sauteing…')
  expect(await spinner($, { message: 'Compacting conversation…', suffix: '' })).toBe('Compacting conversation…')
  expect(await turnDuration($, 'Baked')).toBe('Baked for 3000ms')
})

test('/i18n status 统计等待界面', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)
  on('command.register', () => ({ value: { command: 'i18n' } }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // 同一句状态文字重画多次只算一次
  await spinner($, { message: 'Compacting conversation…', suffix: '' })
  await spinner($, { message: 'Compacting conversation…', suffix: '' })
  await spinner($, { message: 'Frobnicating 3 widgets', suffix: '…' })
  await spinner($, { word: 'Sauteing' })
  await spinner($, { word: 'Sauteing' })
  await turnDuration($, 'Baked')

  const { text } = await $.command.run({
    command: 'i18n',
    args: 'status',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(text).toContain('状态文字本会话 2 种，命中 1；英文动词换成中文 1 个（等待中）、1 个（回合结束）')
  expect(text).toContain('(等待中)  Frobnicating # widgets  ×1')
})

const src: Sources = {
  local: new Map([['Thinking hard', '']]),
  dict: new Map(Object.entries(DICT)),
  templates: compileTemplates(DICT),
}

test('translateStatus：双语显示、本地词典空值、找不到', () => {
  expect(translateStatus('Compacting conversation…', src, 'bilingual')).toBe('压缩对话中 · Compacting conversation…')
  expect(translateStatus('Thinking hard', src, 'translation')).toBeUndefined()
  expect(translateStatus('…', src, 'translation')).toBeUndefined()
  expect(translateStatus('Frobnicating', src, 'translation')).toBeUndefined()
})

test('pickByHash：稳定、落在列表里、空列表返回 undefined', () => {
  expect(pickByHash('Baked', DONE_VERBS)).toBe(pickByHash('Baked', DONE_VERBS))
  expect(DONE_VERBS).toContain(pickByHash('Churned', DONE_VERBS))
  expect(pickByHash('Baked', [])).toBeUndefined()
})
