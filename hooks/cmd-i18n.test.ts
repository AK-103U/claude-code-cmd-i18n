import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { render, restoreListing } from './core'

// 每个 hook 都代表 plugin 下层的引擎：describe 事件原样回显声明的内容。
const BUILTIN = { plugin: 'engine', tier: 'core' } as const

function describeInput(command: string, description: string) {
  return { command, description, isHidden: false, immediate: false, provider: BUILTIN }
}

function configInput(key: string, label: string, description?: string) {
  return { key, label, ...(description !== undefined && { description }), isHidden: false, provider: BUILTIN }
}

function engine(on: On) {
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.describe', (_, e) => ({
    description: e.description,
    argumentHint: e.argumentHint,
    isHidden: e.isHidden,
  }))
  on('config.describe', (_, e) => ({
    label: e.label,
    ...(e.description !== undefined && { description: e.description }),
    isHidden: e.isHidden,
  }))
}

const DATA_DIR = '/data/cmd-i18n'
const LOCAL_FILE = `${DATA_DIR}/local.zh-CN.json`

type Content = Record<string, string> | string | undefined

/**
 * 代表磁盘和引擎给的插件数据目录。
 * - local：本地词典（数据目录里的 local.zh-CN.json）；不给 = 文件不存在
 * - shipped：随 mod 发布的 dict/zh-CN.json；不给 = 文件不存在
 * - dataDir: null：引擎拿不到数据目录
 */
function disk(on: On, local?: Content, opts: { shipped?: Content; dataDir?: string | null } = {}) {
  const text = (c: Content) => (c === undefined ? undefined : typeof c === 'string' ? c : JSON.stringify(c))
  let content = text(local)
  const shipped = text(opts.shipped)
  const dataDir = opts.dataDir === undefined ? DATA_DIR : opts.dataDir
  const writes: { path: string; text: string }[] = []
  on('process.hookEnv', () =>
    dataDir === null ? { deny: 'no data folder' } : { value: { CLAUDE_PLUGIN_DATA: `${dataDir}/` } },
  )
  on('fs.read', (_, e) => {
    const found = e.path === LOCAL_FILE ? content : e.path.endsWith('/dict/zh-CN.json') ? shipped : undefined
    return found === undefined ? { deny: `ENOENT: ${e.path}` } : { value: found }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    if (e.path === LOCAL_FILE) content = e.text
    return { value: undefined }
  })
  return {
    writes,
    /** 模拟你在会话进行中手改了本地词典 */
    edit: (next: string) => {
      content = next
    },
  }
}

function runI18n($: Engine, args: string) {
  return $.command.run({
    command: 'i18n',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

function backgroundEngine(on: On, reply: string, asked: string[] = []) {
  on('command.register', () => ({ value: { command: 'i18n' } }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: reply,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  return asked
}

test('词典命中：内置命令显示中文译文', async ($, on) => {
  mock.store(on)
  engine(on)
  const r = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(r.description).toBe('清除对话历史并释放上下文')
  expect(r.isHidden).toBe(false)
})

test('模板命中：动态值填回译文', async ($, on) => {
  mock.store(on)
  engine(on)
  const r = await $.command.describe(describeInput('x', 'Agent transcripts: /tmp/a.jsonl'))
  expect(r.description).toBe('Agent 记录：/tmp/a.jsonl')
})

test('无译文与已是中文的描述原样通过', { options: { autoTranslate: false } }, async ($, on) => {
  mock.store(on)
  engine(on)
  const unknown = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(unknown.description).toBe('Frobnicate the widgets')
  const zh = await $.command.describe(describeInput('bar', '已经是中文的描述'))
  expect(zh.description).toBe('已经是中文的描述')
})

test('双语模式：译文 · 原文', { options: { display: 'bilingual' } }, async ($, on) => {
  mock.store(on)
  engine(on)
  const r = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(r.description).toBe('清除对话历史并释放上下文 · Clear conversation history and free up context')
})

test('关闭开关后显示英文原文', async ($, on) => {
  mock.store(on, { enabled: false })
  engine(on)
  const r = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(r.description).toBe('Clear conversation history and free up context')
})

test('本地词典里的译文直接命中，不请求模型', async ($, on) => {
  mock.store(on)
  engine(on)
  disk(on, { 'Frobnicate the widgets': '摆弄小部件' })
  const r = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(r.description).toBe('摆弄小部件')
})

test('本地词典优先于内置词典：可以改掉内置不顺眼的译文', async ($, on) => {
  mock.store(on)
  engine(on)
  disk(on, { 'Clear conversation history and free up context': '清空对话' })
  const r = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(r.description).toBe('清空对话')
})

test('本地词典里值为空：不显示译文，也不再请求模型', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on)
  disk(on, { 'Frobnicate the widgets': '' })
  const asked = backgroundEngine(on, '["不该被请求"]')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  await clock.advance(2000)
  expect(r.description).toBe('Frobnicate the widgets')
  expect(asked).toEqual([])
})

test('模型补翻一次后写进本地词典，并保留文件里已有的条目', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on)
  const file = disk(on, { 'Already there': '已有条目' })
  const asked = backgroundEngine(on, '["摆弄小部件"]')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const before = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(before.description).toBe('Frobnicate the widgets')

  // 翻译进行前你手改了文件：改动要保留
  file.edit(JSON.stringify({ 'Already there': '已有条目（手改）' }))
  await clock.advance(2000)
  expect(asked).toEqual(['["Frobnicate the widgets"]'])

  expect(file.writes.length).toBe(1)
  // 写在插件数据目录里（更新、重装 mod 都保留），不写进 mod 自己的目录
  expect(file.writes[0]?.path).toBe(LOCAL_FILE)
  expect(JSON.parse(file.writes[0]?.text ?? '{}')).toEqual({
    'Already there': '已有条目（手改）',
    'Frobnicate the widgets': '摆弄小部件',
  })

  const after = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(after.description).toBe('摆弄小部件')
})

test('本地词典格式坏了：不写盘，免得覆盖你正在改的文件；本会话照样显示译文', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on)
  const file = disk(on, '{ "Already there": "已有条目", ')
  backgroundEngine(on, '["摆弄小部件"]')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  await clock.advance(2000)

  expect(file.writes).toEqual([])
  const after = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(after.description).toBe('摆弄小部件')
})

test('内置词典 dict/zh-CN.json：补充并修正基础词典，本地词典仍然优先', async ($, on) => {
  mock.store(on)
  engine(on)
  disk(on, { 'Frobnicate the widgets': '我的译法' }, {
    shipped: {
      'Frobnicate the widgets': '摆弄小部件',
      'Clear conversation history and free up context': '清空对话并释放上下文',
      'Scan ${...} for widgets': '扫描 ${...} 里的小部件',
    },
  })
  const mine = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(mine.description).toBe('我的译法')
  const fixed = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(fixed.description).toBe('清空对话并释放上下文')
  const templated = await $.command.describe(describeInput('scan', 'Scan /tmp/a for widgets'))
  expect(templated.description).toBe('扫描 /tmp/a 里的小部件')
})

test('内置词典里值为空：不显示译文，也不请求模型；本地词典可以再补回译文', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on)
  disk(on, { 'Bar the foo': '我要译文' }, { shipped: { 'Frobnicate the widgets': '', 'Bar the foo': '' } })
  const asked = backgroundEngine(on, '["不该被请求"]')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  const back = await $.command.describe(describeInput('bar', 'Bar the foo'))
  await clock.advance(2000)
  expect(r.description).toBe('Frobnicate the widgets')
  expect(back.description).toBe('我要译文')
  expect(asked).toEqual([])
})

test('dict/zh-CN.json 坏了或不存在：退回基础词典，status 提示', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)
  disk(on, undefined, { shipped: '{ "oops": ' })
  backgroundEngine(on, '[]')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.describe(
    describeInput('clear', 'Clear conversation history and free up context'),
  )
  expect(r.description).toBe('清除对话历史并释放上下文')
  const { text } = await runI18n($, 'status')
  expect(text).toContain('dict/zh-CN.json 不是合法的 JSON，已跳过')
})

test('拿不到插件数据目录：不写盘，本会话照样显示译文，status 提示', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on)
  const file = disk(on, undefined, { dataDir: null })
  backgroundEngine(on, '["摆弄小部件"]')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  await clock.advance(2000)

  expect(file.writes).toEqual([])
  const after = await $.command.describe(describeInput('foo', 'Frobnicate the widgets'))
  expect(after.description).toBe('摆弄小部件')
  const { text } = await runI18n($, 'status')
  expect(text).toContain('拿不到插件数据目录')
})

test('/i18n status 显示本地词典在数据目录里的路径', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)
  disk(on, { 'Frobnicate the widgets': '摆弄小部件' }, { shipped: { 'Bar the foo': '把 foo 挡住' } })
  backgroundEngine(on, '[]')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { text } = await runI18n($, 'status')
  expect(text).toContain(`本地词典 1 条`)
  expect(text).toContain(LOCAL_FILE)
  expect(text).toContain('其中 dict/zh-CN.json 1 条')
})

test('发给模型的 skill 列表还原为英文原文', async ($, on) => {
  mock.store(on)
  engine(on)
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  await $.command.describe(
    describeInput('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  )
  const listing = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- init: 用代码库文档初始化新的 CLAUDE.md 文件',
    '- loop: 在固定间隔内运行 - When the user wants to poll',
    '- zh-cn-setup: 完成中文本地化；参见 init: 用代码库文档初始化新的 CLAUDE.md 文件',
  ].join('\n')
  const r = await $.prompt.attachment({ type: 'skill_listing', text: listing, origin: { kind: 'engine' } })
  const lines = (r.text ?? '').split('\n')
  expect(lines[2]).toBe('- init: Initialize a new CLAUDE.md file with codebase documentation')
  // 没被本 mod 翻译过的命令、以及正文里碰巧出现的同样文字，都不动
  expect(lines[3]).toBe('- loop: 在固定间隔内运行 - When the user wants to poll')
  expect(lines[4]).toBe('- zh-cn-setup: 完成中文本地化；参见 init: 用代码库文档初始化新的 CLAUDE.md 文件')
})

test('其他类型的 attachment 不受影响', async ($, on) => {
  mock.store(on)
  engine(on)
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  await $.command.describe(describeInput('init', 'Initialize a new CLAUDE.md file with codebase documentation'))
  const text = '- init: 用代码库文档初始化新的 CLAUDE.md 文件'
  const r = await $.prompt.attachment({ type: 'todo_reminder', text, origin: { kind: 'engine' } })
  expect(r.text).toBe(text)
})

test('restoreListing：截断、多行、命名空间命令名', () => {
  const shown = new Map([
    ['loop', { original: 'Run a prompt on a recurring interval', rendered: '在固定间隔内运行提示词或斜杠命令，省略间隔则自行调整节奏' }],
    ['plug:multi', { original: 'Line one\nline two', rendered: '第一行内容在这里\n第二行内容在这里' }],
  ])
  const text = [
    '- loop: 在固定间隔内运行提示词或斜杠命令，省…',
    '- plug:multi: 第一行内容在这里',
    '第二行内容在这里 - Use when testing',
  ].join('\n')
  const out = restoreListing(text, shown).split('\n')
  // 截断：按共同前缀长度（这里 18 个字）换回同样长度的原文，截断标记保留
  expect(out[0]).toBe(`- loop: ${'Run a prompt on a recurring interval'.slice(0, 18)}…`)
  expect(out.slice(1).join('\n')).toBe('- plug:multi: Line one\nline two - Use when testing')
})

test('restoreListing：原文超过引擎上限时按上限截断', () => {
  const original = 'x'.repeat(40)
  const shown = new Map([['big', { original, rendered: '很短的中文译文内容在这里' }]])
  const out = restoreListing('- big: 很短的中文译文内容在这里', shown, 10)
  expect(out).toBe(`- big: ${'x'.repeat(9)}…`)
})

test('/config：标签显示中文译文，key 不变', async ($, on) => {
  mock.store(on)
  engine(on)
  const r = await $.config.describe(configInput('copyOnSelect', 'Copy on select'))
  expect(r.label).toBe('选中即复制')
  expect(r.description).toBe(undefined)
  expect(r.isHidden).toBe(false)
})

test('/config：插件设置项的说明文字也翻译', async ($, on) => {
  mock.store(on)
  disk(on, { 'Auto charts': '自动图表', 'Draw a chart under an MCP result.': '在 MCP 结果下方画图。' })
  engine(on)
  const r = await $.config.describe(
    configInput('charts.autoCharts', 'Auto charts', 'Draw a chart under an MCP result.'),
  )
  expect(r.label).toBe('自动图表')
  expect(r.description).toBe('在 MCP 结果下方画图。')
})

test('/config：没有译文、已是中文、关闭开关时原样通过', { options: { autoTranslate: false } }, async ($, on) => {
  mock.store(on)
  engine(on)
  const unknown = await $.config.describe(configInput('x', 'Frobnicate level', 'How hard to frobnicate.'))
  expect(unknown.label).toBe('Frobnicate level')
  expect(unknown.description).toBe('How hard to frobnicate.')
  const zh = await $.config.describe(configInput('cmd-i18n.display', '命令描述显示方式'))
  expect(zh.label).toBe('命令描述显示方式')
})

test('/config：关闭开关后标签恢复英文', async ($, on) => {
  mock.store(on, { enabled: false })
  engine(on)
  const r = await $.config.describe(configInput('copyOnSelect', 'Copy on select'))
  expect(r.label).toBe('Copy on select')
})

test('render：保留原文首尾空白（标签后会拼加粗后缀）', () => {
  expect(render('Use custom API key: ', '使用自定义 API key：', 'translation')).toBe('使用自定义 API key： ')
  expect(render(' Theme', '主题', 'bilingual')).toBe(' 主题 · Theme')
})
