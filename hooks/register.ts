import type {
  CommandInfo,
  ConfigRow,
  EngineInterface,
  ModelCompleteRequest,
  ModelCompleteResult,
  Register,
  Timer,
} from 'claude-code'

import {
  batches,
  compileTemplates,
  hasCjk,
  isSuppressed,
  lookup,
  normalizeMiss,
  parseDictionary,
  parseReply,
  pickByHash,
  render,
  restoreListing,
  serializeDictionary,
  SYSTEM,
  translateOutput,
  translateStatus,
} from './core'
import type { Display, OutputTranslation, Sources } from './core'
import { DICT } from './dict'
import { DONE_VERBS, SPINNER_VERBS } from './verbs'

// 只改"显示"：typeahead 与 /help 里的命令描述（command.describe），/config 的标签和说明（config.describe），
// 命令打印在对话里的输出行（ui.render 的 CommandOutput，只查词典不调模型）。
// 等待界面（ui.render 的 Spinner 与 TurnDuration）：状态文字查词典；终端上英文动词换成自带的中文动词。
// 命令名、设置 key、取值、settings.json、对话记录里的输出原文都不动。
// command.describe 的结果引擎也拿去生成模型的 skill 列表，所以另挂 prompt.attachment，
// 把 skill_listing 里的译文换回原文，模型看到的仍是英文。
//
// 词典两层，不依赖任何其他插件：
// - 本地词典：插件数据目录（CLAUDE_PLUGIN_DATA）里的 local.zh-CN.json，优先查。
//   模型补翻的结果和你手改的条目都在这里；更新、重装 mod 都保留。
// - 内置词典：hooks/dict.ts（基础快照）+ dict/zh-CN.json（维护者补的译文），随 mod 发布、随 mod 更新，运行时只读。
// 同一句话模型只翻一次：补翻的结果写进本地词典，以后直接命中。

/** 本地词典的文件名，放在插件数据目录里 */
const LOCAL_DICT = 'local.zh-CN.json'
/** 维护者补的内置译文，相对 mod 根目录 */
const SHIPPED_DICT = 'dict/zh-CN.json'
const ENABLED_KEY = 'enabled'
const MISS_STATS_KEY = 'output-miss-stats'
const MAX_MISSES = 100

/** 读本地状态要用的能力（$ 本身不能存，只能包成闭包） */
type Reader = {
  get: (key: string) => Promise<unknown>
  read: (path: string) => Promise<string>
  /** mod 根目录 */
  root: string
  /** 插件数据目录（引擎负责创建）；拿不到时 reject */
  dataDir: () => Promise<string>
}

function readerOf($: EngineInterface): Reader {
  return {
    get: key => $.store.get(key),
    read: path => $.fs.read(path),
    root: $.plugin.root,
    dataDir: async () => {
      const dir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
      if (!dir) throw new Error('引擎没有给出 CLAUDE_PLUGIN_DATA')
      return dir.replace(/[\\/]+$/, '')
    },
  }
}

/** 后台任务（session.start 里包好）：额外能写文件、写 store、调模型、定时 */
type Background = Reader & {
  set: (key: string, value: unknown) => Promise<void>
  write: (path: string, text: string) => Promise<void>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  invalidate: () => void
  after: (ms: number, fn: () => void) => Timer
}

export const register: Register = (on, options) => {
  const display: Display = options.display === 'bilingual' ? 'bilingual' : 'translation'
  const autoTranslate = options.autoTranslate !== false
  const model =
    typeof options.model === 'string' && options.model.trim() ? options.model.trim() : 'haiku'

  // 内置词典 = 基础快照 + dict/zh-CN.json，后者在 ensureLoaded 里读入后合并
  const dict = new Map(Object.entries(DICT))
  const local = new Map<string, string>()
  const sources: Sources = { local, dict, templates: compileTemplates(DICT) }
  let shippedSize = 0
  let shippedError = ''
  // 本会话菜单里换成译文的命令，供 skill_listing 还原用
  const shown = new Map<string, { original: string; rendered: string }>()
  let restored = 0

  let enabled = true
  let loaded: Promise<void> | undefined
  let bg: Background | undefined
  let timer: Timer | undefined
  let running = false
  const pending = new Set<string>()
  const failed = new Set<string>()
  let lastError = ''
  /** 本地词典的完整路径；undefined = 拿不到插件数据目录，新译文只留在本会话内存里 */
  let localFile: string | undefined
  let dataDirError = ''
  /** 本地词典文件格式坏了（多半是正在手改）：暂停写入，免得覆盖 */
  let localBroken = false
  let written = 0
  const spent = { input: 0, output: 0, calls: 0 }
  // 命令输出：每个输出行只统计一次；未命中按 "/命令  归一化首行" 计数，跨会话累计
  const outputSeen = new Set<string>()
  const outputStats = { total: 0, all: 0, part: 0, none: 0 }
  const misses = new Map<string, number>()
  let missTimer: Timer | undefined
  // 等待界面：每句状态文字只统计一次（spinner 一秒要重画很多次）
  const statusSeen = new Set<string>()
  const statusStats = { total: 0, hit: 0 }
  // 本会话换成中文的英文动词（按词去重）
  const swappedVerbs = { spinner: new Set<string>(), done: new Set<string>() }

  /** 找插件数据目录。拿到一次就记住；拿不到下次再试（session.start 会再试一次）。 */
  const resolveLocalFile = async (io: Reader): Promise<string | undefined> => {
    if (localFile) return localFile
    try {
      localFile = `${await io.dataDir()}/${LOCAL_DICT}`
      dataDirError = ''
    } catch (error) {
      dataDirError = error instanceof Error ? error.message : String(error)
    }
    return localFile
  }

  /** 读本地词典文件：没有数据目录或文件不存在 → 空词典；格式坏了 → undefined。 */
  const readLocalFile = async (io: Reader): Promise<Map<string, string> | undefined> => {
    const path = await resolveLocalFile(io)
    if (!path) return new Map()
    let text: string
    try {
      text = await io.read(path)
    } catch {
      return new Map()
    }
    return parseDictionary(text)
  }

  /** 用文件内容替换内存里的本地词典（手改的条目这样生效）。 */
  const reloadLocal = async (io: Reader) => {
    const onDisk = await readLocalFile(io)
    localBroken = onDisk === undefined
    if (!onDisk) {
      lastError = `本地词典不是合法的 JSON，已暂停写入：${localFile}`
      return
    }
    local.clear()
    for (const [en, zh] of onDisk) local.set(en, zh)
  }

  /** 读入 dict/zh-CN.json，合并进内置词典（同一句以它为准），再重编模板。 */
  const reloadShipped = async (io: Reader) => {
    let parsed: Map<string, string> | undefined
    try {
      parsed = parseDictionary(await io.read(`${io.root}/${SHIPPED_DICT}`))
      shippedError = parsed ? '' : `${SHIPPED_DICT} 不是合法的 JSON，已跳过`
    } catch {
      shippedError = `没找到 ${SHIPPED_DICT}，只用基础词典`
    }
    dict.clear()
    for (const [en, zh] of Object.entries(DICT)) dict.set(en, zh)
    for (const [en, zh] of parsed ?? []) dict.set(en, zh)
    shippedSize = parsed?.size ?? 0
    sources.templates = compileTemplates(Object.fromEntries(dict))
  }

  /**
   * 把新译文写进本地词典：先重新读文件，只补文件里还没有的条目，所以你手改过的不会被冲掉。
   * 文件格式坏了、或者拿不到数据目录，就只留在内存里，本会话照样显示，不写盘。
   */
  const addToLocal = async (io: Background, additions: ReadonlyMap<string, string>) => {
    for (const [en, zh] of additions) if (!local.has(en)) local.set(en, zh)
    const path = await resolveLocalFile(io)
    if (!path) return
    const onDisk = await readLocalFile(io)
    if (!onDisk) {
      localBroken = true
      lastError = `本地词典不是合法的 JSON，新译文只在本会话生效、没有写盘：${path}`
      return
    }
    localBroken = false
    let added = 0
    for (const [en, zh] of additions) {
      if (!onDisk.has(en)) {
        onDisk.set(en, zh)
        added += 1
      }
    }
    for (const [en, zh] of onDisk) local.set(en, zh)
    if (added === 0) return
    await io.write(path, serializeDictionary(onDisk))
    written += added
  }

  const ensureLoaded = (io: Reader) =>
    (loaded ??= (async () => {
      try {
        enabled = (await io.get(ENABLED_KEY)) !== false
        const counted = await io.get(MISS_STATS_KEY)
        if (counted && typeof counted === 'object' && !Array.isArray(counted)) {
          for (const [k, n] of Object.entries(counted as Record<string, unknown>)) {
            if (typeof n === 'number' && n > 0) misses.set(k, n)
          }
        }
      } catch {
        // store 读不到就用默认值
      }
      await Promise.all([reloadShipped(io), reloadLocal(io)])
    })())

  /** 未命中计数（跨会话），5 秒内的多次变化合并成一次写入。 */
  const countMiss = (key: string) => {
    misses.set(key, (misses.get(key) ?? 0) + 1)
    while (misses.size > MAX_MISSES) {
      let rarest: string | undefined
      for (const [k, n] of misses) if (rarest === undefined || n < (misses.get(rarest) ?? 0)) rarest = k
      if (rarest === undefined) break
      misses.delete(rarest)
    }
    const io = bg
    if (!io || missTimer) return
    missTimer = io.after(5000, () => {
      missTimer = undefined
      void io.set(MISS_STATS_KEY, Object.fromEntries(misses)).catch(() => undefined)
    })
  }

  const recordOutput = (id: string, command: string, out: OutputTranslation) => {
    if (outputSeen.has(id)) return
    outputSeen.add(id)
    outputStats.total += 1
    outputStats[out.hit] += 1
    if (out.firstMiss !== undefined) countMiss(`/${command}  ${normalizeMiss(out.firstMiss)}`)
  }

  const recordStatus = (message: string, hit: boolean) => {
    if (statusSeen.has(message)) return
    statusSeen.add(message)
    statusStats.total += 1
    if (hit) statusStats.hit += 1
    else countMiss(`(等待中)  ${normalizeMiss(message)}`)
  }

  /** 查译文；没有就记进待翻译队列。 */
  const translationOf = (en: string): string | undefined => {
    if (!en.trim() || hasCjk(en)) return undefined
    const zh = lookup(en, sources)
    if (zh) return zh
    const key = en.trim()
    if (!isSuppressed(key, sources) && !local.has(key) && !failed.has(key)) pending.add(key)
    return undefined
  }

  const flush = async () => {
    const io = bg
    if (!io || running || !autoTranslate) return
    running = true
    try {
      for (;;) {
        const todo = [...pending].filter(en => !local.has(en) && !failed.has(en))
        pending.clear()
        if (todo.length === 0) break
        for (const batch of batches(todo)) {
          const r = await io.complete({
            model,
            system: SYSTEM,
            prompt: JSON.stringify(batch),
            maxTokens: 8000,
            effort: 'low',
            timeoutMs: 120_000,
          })
          spent.calls += 1
          spent.input += r.usage.input_tokens
          spent.output += r.usage.output_tokens
          const out = r.isAnswered ? parseReply(r.text, batch.length) : undefined
          if (!out) {
            for (const en of batch) failed.add(en)
            lastError = r.isAnswered
              ? '模型回复不是等长的 JSON 数组'
              : `${r.reason}${'status' in r && r.status ? ` (HTTP ${r.status})` : ''}`
            continue
          }
          const additions = new Map<string, string>()
          batch.forEach((en, i) => {
            const zh = out[i] ?? ''
            additions.set(en, hasCjk(zh) ? zh : '')
          })
          await addToLocal(io, additions)
          io.invalidate()
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      running = false
    }
  }

  const schedule = () => {
    const io = bg
    if (!autoTranslate || !io || timer || running || pending.size === 0) return
    timer = io.after(1500, () => {
      timer = undefined
      void flush()
    })
  }

  /** 列出全部命令和 /config 行，把缺译文的排进队列。 */
  const scan = async (
    listCommands: () => Promise<CommandInfo[]>,
    listConfig: () => Promise<ConfigRow[]>,
  ) => {
    const [commands, rows] = await Promise.all([listCommands(), listConfig()])
    for (const c of commands) translationOf(c.description)
    for (const r of rows) {
      translationOf(r.label)
      if (r.description) translationOf(r.description)
    }
    schedule()
    return { commands, rows }
  }

  on('session.start', async ($, e, next) => {
    const io: Background = {
      ...readerOf($),
      set: (key, value) => $.store.set(key, value),
      write: (path, text) => $.fs.write(path, text),
      complete: request => $.model.complete(request),
      invalidate: () => {
        $.ui.invalidate('command.describe')
        $.ui.invalidate('config.describe')
      },
      after: (ms, fn) => $.clock.after(ms, fn),
    }
    bg = io
    await ensureLoaded(io)
    // 会话开始前就画过菜单的话，那次可能还拿不到数据目录：这里再试一次
    if (!localFile && (await resolveLocalFile(io))) await reloadLocal(io)
    await $.command.register({
      name: 'i18n',
      description: '界面翻译（命令菜单、/config、命令输出、等待界面）：status 查看状态 · on/off 开关 · refresh 重读本地词典并补翻',
      argumentHint: '[status|on|off|refresh]',
    })
    // 词典加载前若已有描述被列出，让它们重新走一遍
    $.ui.invalidate('command.describe')
    $.ui.invalidate('config.describe')
    const result = await next(e)
    $.clock.after(3000, () => {
      void scan(
        () => $.command.list(),
        () => $.config.list(),
      ).catch(() => undefined)
    })
    return result
  })

  on('command.describe', async ($, e, next) => {
    const answer = await next(e)
    await ensureLoaded(readerOf($))
    const zh = enabled ? translationOf(answer.description) : undefined
    schedule()
    if (!zh) {
      shown.delete(e.command)
      return answer
    }
    const rendered = render(answer.description, zh, display)
    shown.set(e.command, { original: answer.description, rendered })
    return { ...answer, description: rendered }
  })

  on('config.describe', async ($, e, next) => {
    const answer = await next(e)
    await ensureLoaded(readerOf($))
    if (!enabled) return answer
    const label = translationOf(answer.label)
    const description = answer.description ? translationOf(answer.description) : undefined
    schedule()
    if (!label && !description) return answer
    return {
      ...answer,
      label: label ? render(answer.label, label, display) : answer.label,
      ...(answer.description !== undefined && {
        description: description ? render(answer.description, description, display) : answer.description,
      }),
    }
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const answer = await next(e)
    if (typeof answer.text !== 'string' || shown.size === 0) return answer
    const text = restoreListing(answer.text, shown)
    if (text !== answer.text) restored += 1
    return { ...answer, text }
  })

  // 命令打印的输出行：改写 props.text 只改画出来的，对话记录和模型读到的仍是原文。
  // 只查词典和模板，不调模型；出错行保持英文，便于排查。
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    await ensureLoaded(readerOf($))
    const { command, text, isErrored } = e.props
    if (!enabled || isErrored || !text.trim() || hasCjk(text)) return next(e)
    const out = translateOutput(text, sources, display)
    recordOutput(e.requestId ?? `${command}\u0000${text}`, command, out)
    if (out.hit === 'none') return next(e)
    return next({ ...e, props: { ...e.props, text: out.text } })
  })

  // 等待中那一行。只改 word / message，耗时、tokens、effort 由引擎自己画，mod 碰不到。
  // - message（压缩对话、重试之类覆盖动词的状态文字）：只查词典，不调模型。
  // - word：终端上画的是随机动词。settings 的 spinnerVerbs 已经是中文就原样不动；
  //   引擎画出英文动词时（比如 spinnerVerbs 被删了），按哈希换成自带的中文动词。
  //   desktop 上 word 是步骤说明（"Creating notes.md"），不是动词，不碰。
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    await ensureLoaded(readerOf($))
    if (!enabled) return next(e)
    const { word, message } = e.props
    let props = e.props
    if (message && message.trim() && !hasCjk(message)) {
      const zh = translateStatus(message, sources, display)
      recordStatus(message, zh !== undefined)
      if (zh) props = { ...props, message: zh }
    } else if (!message && e.surface === 'terminal' && word.trim() && !hasCjk(word)) {
      const zh = pickByHash(word.trim(), SPINNER_VERBS)
      if (zh) {
        swappedVerbs.spinner.add(word.trim())
        props = { ...props, word: zh }
      }
    }
    return props === e.props ? next(e) : next({ ...e, props })
  })

  // 回合结束那一行（"Baked for 3s"）：英文过去式换成中文，" for 3s" 由引擎拼，改不了。
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    await ensureLoaded(readerOf($))
    const { word } = e.props
    if (!enabled || !word.trim() || hasCjk(word)) return next(e)
    const zh = pickByHash(word.trim(), DONE_VERBS)
    if (!zh) return next(e)
    swappedVerbs.done.add(word.trim())
    return next({ ...e, props: { ...e.props, word: zh } })
  })

  on('command.run', { command: 'i18n' }, async ($, e) => {
    const reader = readerOf($)
    await ensureLoaded(reader)
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set(ENABLED_KEY, enabled)
      $.ui.invalidate('command.describe')
      $.ui.invalidate('config.describe')
      $.ui.invalidate('ui.render')
      return {
        text: enabled
          ? '已开启：命令菜单、/config、命令输出和等待界面显示中文。'
          : '已关闭：命令菜单、/config、命令输出和等待界面恢复英文原文。',
      }
    }

    if (arg === 'refresh') {
      await Promise.all([reloadShipped(reader), reloadLocal(reader)])
      failed.clear()
      $.ui.invalidate('command.describe')
      $.ui.invalidate('config.describe')
      $.ui.invalidate('ui.render')
      await scan(
        () => $.command.list(),
        () => $.config.list(),
      )
      const head = localBroken
        ? `本地词典格式有误，没有重新载入：${localFile}`
        : `已重新载入词典（本地 ${local.size} 条，内置 ${dict.size} 条）`
      return {
        text: autoTranslate
          ? `${head}；${pending.size} 条待补翻，后台进行中，译文会写进本地词典。`
          : `${head}；${pending.size} 条缺译文，自动翻译已在 /config 里关闭。`,
      }
    }

    const all = await $.command.list()
    const missing = all.filter(
      c => !hasCjk(c.description) && !lookup(c.description, sources) && !isSuppressed(c.description, sources),
    )
    const rows = await $.config.list()
    const rowsMissing = rows.filter(
      r => !hasCjk(r.label) && !lookup(r.label, sources) && !isSuppressed(r.label, sources),
    )
    const lines = [
      'cmd-i18n 状态',
      `- 显示：${enabled ? '开启' : '关闭'}（${display === 'bilingual' ? '译文 · 原文' : '仅译文'}）`,
      `- 覆盖：命令 ${all.length - missing.length} / ${all.length} 条；/config 设置项 ${rows.length - rowsMissing.length} / ${rows.length} 行`,
      localFile
        ? `- 本地词典 ${local.size} 条（优先查，本会话新写入 ${written} 条）：${localFile}${localBroken ? '  ⚠ 格式有误，暂停写入' : ''}`
        : `- 本地词典 ${local.size} 条：⚠ 拿不到插件数据目录（${dataDirError}），新译文只在本会话生效`,
      `- 内置词典 ${dict.size} 条（其中 ${SHIPPED_DICT} ${shippedSize} 条，模板 ${sources.templates.length} 条；随 mod 更新，只读）${shippedError ? `  ⚠ ${shippedError}` : ''}`,
      `- 自动补翻：${autoTranslate ? `开启（${model}，结果写进本地词典；可在 /config 关闭）` : '关闭'}；待翻译 ${pending.size} 条，失败 ${failed.size} 条${running ? '，翻译中…' : ''}`,
      `- 本会话模型用量：${spent.calls} 次调用，输入 ${spent.input} / 输出 ${spent.output} tokens`,
      `- 模型侧 skill 列表：译文已还原为原文（本会话还原 ${restored} 次，跟踪 ${shown.size} 条命令）`,
      `- 命令输出（只查词典）：本会话 ${outputStats.total} 条，整段翻译 ${outputStats.all}、部分翻译 ${outputStats.part}、未命中 ${outputStats.none}`,
      `- 等待界面（只查词典）：状态文字本会话 ${statusStats.total} 种，命中 ${statusStats.hit}；英文动词换成中文 ${swappedVerbs.spinner.size} 个（等待中）、${swappedVerbs.done.size} 个（回合结束）`,
    ]
    if (lastError) lines.push(`- 最近错误：${lastError}`)
    if (missing.length) {
      const names = missing
        .slice(0, 12)
        .map(c => `/${c.name}`)
        .join('  ')
      lines.push(`- 暂无译文：${names}${missing.length > 12 ? ` 等 ${missing.length} 条` : ''}`)
    }
    if (rowsMissing.length) {
      const labels = rowsMissing
        .slice(0, 8)
        .map(r => r.label.trim())
        .join('、')
      lines.push(`- /config 暂无译文：${labels}${rowsMissing.length > 8 ? ` 等 ${rowsMissing.length} 行` : ''}`)
    }
    if (misses.size) {
      const top = [...misses]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, n]) => `    ${k}  ×${n}`)
      lines.push('- 命令输出和等待界面的常见未命中（跨会话累计，可据此补本地词典）：', ...top)
    }
    return { text: lines.join('\n') }
  })
}
