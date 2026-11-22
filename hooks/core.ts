// 纯逻辑：词典查找、模板匹配、翻译请求的构造与解析。不碰 $，便于单测。

export type Display = 'translation' | 'bilingual'

const HOLE = '${...}'
const CJK = /[㐀-鿿豈-﫿]/

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

type Template = { re: RegExp; parts: string[] }

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 词典里含 ${...} 的条目是模板字符串（如 "Set the model (currently ${...})"），
 * 编成正则，命中后把捕获到的动态值按顺序填回译文。
 */
export function compileTemplates(dict: Readonly<Record<string, string>>): Template[] {
  const out: Template[] = []
  for (const [en, zh] of Object.entries(dict)) {
    if (!en.includes(HOLE)) continue
    const enParts = en.split(HOLE)
    const zhParts = zh.split(HOLE)
    if (enParts.length !== zhParts.length) continue
    // 字面量太少的模板几乎什么都能匹配，跳过
    if (enParts.join('').trim().length < 8) continue
    const re = new RegExp(`^${enParts.map(escapeRe).join('(.+?)')}$`, 's')
    out.push({ re, parts: zhParts })
  }
  return out
}

export type Sources = {
  /**
   * 本地词典（插件数据目录里的 local.zh-CN.json，更新、重装都保留）：
   * 模型补翻的结果和你手改的条目都在这里，查词时最先查。
   */
  local: ReadonlyMap<string, string>
  /**
   * 内置词典（随 mod 发布、随 mod 更新，运行时只读）：
   * hooks/dict.ts 的基础词典，加上 dict/zh-CN.json 里维护者补的译文（同一句以后者为准）。
   */
  dict: ReadonlyMap<string, string>
  templates: readonly Template[]
}

/**
 * 两层词典里值都可以是空串，表示"这条不需要译文"：不显示译文，也不再请求模型。
 * 本地词典里的空串连内置词典的译文一起盖掉。
 */
export function isSuppressed(en: string, src: Sources): boolean {
  const key = en.trim()
  const mine = src.local.get(key)
  return mine !== undefined ? mine === '' : src.dict.get(key) === ''
}

/** 按 本地词典 → 内置词典 → 模板 的顺序找译文；找不到返回 undefined。 */
export function lookup(
  en: string,
  src: Sources,
  options: { strictTemplates?: boolean } = {},
): string | undefined {
  const key = en.trim()
  if (!key) return undefined
  const mine = src.local.get(key)
  if (mine !== undefined) return mine || undefined
  const exact = src.dict.get(key) ?? src.dict.get(en)
  if (exact !== undefined) return exact || undefined
  for (const t of src.templates) {
    const m = t.re.exec(key)
    if (!m) continue
    if (options.strictTemplates && !isCleanTemplateHit(key, m.slice(1))) continue
    return t.parts.reduce((acc, part, i) => (i === 0 ? part : acc + m[i] + part), '')
  }
  return undefined
}

/**
 * 解析词典文件（本地词典、dict/zh-CN.json）：一个 { 英文原文: 中文译文 } 的 JSON 对象。
 * 空文件当作空词典；格式不对返回 undefined，调用方据此暂停写入，免得覆盖你正在改的文件。
 */
export function parseDictionary(text: string): Map<string, string> | undefined {
  const body = text.replace(/^﻿/, '')
  if (!body.trim()) return new Map()
  try {
    const data: unknown = JSON.parse(body)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    const out = new Map<string, string>()
    for (const [en, zh] of Object.entries(data)) {
      if (typeof zh === 'string' && en.trim()) out.set(en.trim(), zh)
    }
    return out
  } catch {
    return undefined
  }
}

/** 按英文原文排序、两空格缩进写出，方便你直接打开审阅和修改。 */
export function serializeDictionary(dict: ReadonlyMap<string, string>): string {
  const sorted = [...dict].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`
}

/**
 * 命令输出里夹着动态内容，模板容易套错（"Compacted. 2 pending" 被当成 "${...} pending"）。
 * 只接受：每个挖空捕获都不含空白（数字、路径、模型名之类），或模板字面量占整行一半以上。
 */
function isCleanTemplateHit(line: string, captures: readonly string[]): boolean {
  if (captures.every(c => !/\s/.test(c))) return true
  const literal = line.length - captures.reduce((n, c) => n + c.length, 0)
  return literal / line.length >= 0.5
}

export type OutputTranslation = {
  text: string
  /** all：每行可译文字都翻了；part：翻了一部分；none：一行都没命中 */
  hit: 'all' | 'part' | 'none'
  /** 第一行没命中的文字，用于统计常见未命中 */
  firstMiss?: string
}

const LIST_MARK = /^(\s*(?:[-*•⎿]\s+)?)(.*?)(\s*)$/s

/**
 * 命令打印的输出：先整段查，查不到再逐行查词典和模板（严格模式），保留行首缩进与列表符号。
 * 只查不翻：不排队、不调模型。
 */
export function translateOutput(text: string, src: Sources, display: Display): OutputTranslation {
  const whole = lookup(text, src, { strictTemplates: true })
  if (whole) return { text: render(text, whole, display), hit: 'all' }
  let translatable = 0
  let translated = 0
  let firstMiss: string | undefined
  const lines = text.split('\n').map(line => {
    if (!line.trim() || hasCjk(line)) return line
    const [, lead = '', body = '', trail = ''] = LIST_MARK.exec(line) ?? []
    if (!/[A-Za-z]{2}/.test(body)) return line
    translatable += 1
    const zh = lookup(body, src, { strictTemplates: true })
    if (!zh) {
      firstMiss ??= body
      return line
    }
    translated += 1
    return lead + render(body, zh, display) + trail
  })
  const hit = translated === 0 ? 'none' : translated === translatable ? 'all' : 'part'
  return { text: hit === 'none' ? text : lines.join('\n'), hit, ...(firstMiss !== undefined && { firstMiss }) }
}

/** 未命中统计的键：数字归一成 #，压缩空白，截到 80 字符，避免同一句话因数字不同被算成多条。 */
export function normalizeMiss(line: string): string {
  return line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 按英文词的哈希（FNV-1a）从列表里挑一个：同一个英文词总得到同一个中文词，
 * 一个回合里重画多次也不会跳来跳去。
 */
export function pickByHash(word: string, list: readonly string[]): string | undefined {
  if (list.length === 0) return undefined
  let h = 0x811c9dc5
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return list[h % list.length]
}

const TRAILING_ELLIPSIS = /\s*(…|\.\.\.)(\s*)$/

/**
 * 等待状态文字（Spinner 的 message）：词典里同一句话常有带省略号和不带省略号两种写法，
 * 所以按 原文 → 去掉省略号 → 换成 … / ... 的顺序查。译文去掉自带的省略号后按原文补回：
 * 原文带省略号，译文末尾带同样的一个；原文不带（引擎会在后面补），译文也不带，免得画出两个。
 * 词典里写成空值的写法（"不要译文"）直接停，不再退回别的写法。
 */
export function translateStatus(text: string, src: Sources, display: Display): string | undefined {
  const m = TRAILING_ELLIPSIS.exec(text)
  const bare = m ? text.slice(0, m.index) : text
  if (!bare.trim()) return undefined
  const tail = m ? `${m[1]}${m[2]}` : ''
  for (const candidate of new Set([text, bare, `${bare.trimEnd()}…`, `${bare.trimEnd()}...`])) {
    if (isSuppressed(candidate, src)) return undefined
    const zh = lookup(candidate, src, { strictTemplates: true })
    if (!zh) continue
    const zhBare = zh.trim().replace(TRAILING_ELLIPSIS, '')
    return zhBare ? render(bare, zhBare, display) + tail : undefined
  }
  return undefined
}

/** 把译文套回原文的首尾空白：有的 /config 标签以 ": " 结尾，后面还会拼一段加粗后缀。 */
export function render(en: string, zh: string, display: Display): string {
  const lead = /^\s*/.exec(en)?.[0] ?? ''
  const trail = /\s*$/.exec(en)?.[0] ?? ''
  const body = display === 'bilingual' ? `${zh.trim()} · ${en.trim()}` : zh.trim()
  return lead + body + trail
}

/** 把待翻译文本切成批：每批不超过 maxItems 条、maxChars 字符。 */
export function batches(items: readonly string[], maxChars = 6000, maxItems = 25): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let size = 0
  for (const item of items) {
    if (cur.length && (cur.length >= maxItems || size + item.length > maxChars)) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(item)
    size += item.length
  }
  if (cur.length) out.push(cur)
  return out
}

export const SYSTEM = `You localize the user interface of Claude Code, a terminal coding assistant, into Simplified Chinese.
The input is a JSON array of English strings shown one line each in a menu: descriptions of slash commands and skills, and labels and help text of settings in the /config menu.
Translate each string faithfully into natural, concise Simplified Chinese. A setting label stays a short noun phrase.
Rules:
- Keep unchanged: product and tool names (Claude, Claude Code, Anthropic, MCP, GitHub, Slack, VS Code), code identifiers, file names and paths (CLAUDE.md, settings.json), slash commands (/loop), flags (--fix), environment variables, model ids, URLs, quoted literals and placeholders.
- Keep technical terms in English where Chinese developers use them as-is (API, PR, diff, hook, skill, token, prompt, plugin, subagent, worktree).
- Do not add, drop or explain anything. Do not wrap a translation in quotes.
- Use Chinese punctuation inside Chinese text.
Reply with only a JSON array of strings, the same length and order as the input.`

/** 解析模型回复：取最外层 JSON 数组，长度必须与请求一致。 */
export function parseReply(text: string, expected: number): string[] | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr) || arr.length !== expected) return undefined
    if (!arr.every(s => typeof s === 'string')) return undefined
    return (arr as string[]).map(s => s.trim())
  } catch {
    return undefined
  }
}

/** 本会话菜单里换成译文的命令：命令名 → 原文与显示出来的文本。 */
export type Shown = ReadonlyMap<string, { original: string; rendered: string }>

/** 截断时至少要和译文有这么长的共同前缀，才认定是同一条描述。 */
const MIN_PREFIX = 12
/** 引擎给每条 skill 描述的字符上限（settings 的 skillListingMaxDescChars，默认 1536）。 */
export const LISTING_MAX_DESC_CHARS = 1536

function atLineStart(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^\s*$/.test(text.slice(lineStart, at))
}

/**
 * 把发给模型的 skill 列表里的译文换回原文。
 *
 * 只动 "- 命令名: " 后面紧跟的描述位置，不做全文替换，所以本来就用中文写的描述
 * 不会被误改。描述被引擎截断时，按与译文的共同前缀长度换回同样长度的原文；
 * 译文完整而原文超过引擎上限时，按上限截断原文，和不装本 mod 时引擎的做法一致。
 */
export function restoreListing(text: string, shown: Shown, maxChars = LISTING_MAX_DESC_CHARS): string {
  let out = text
  for (const [name, { original, rendered }] of shown) {
    const head = `- ${name}: `
    let from = 0
    for (;;) {
      const at = out.indexOf(head, from)
      if (at < 0) break
      const start = at + head.length
      let n = 0
      while (n < rendered.length && out[start + n] === rendered[n]) n++
      const isWhole = n === rendered.length
      if (atLineStart(out, at) && (isWhole || n >= MIN_PREFIX)) {
        const back = isWhole
          ? original.length > maxChars
            ? `${original.slice(0, maxChars - 1)}…`
            : original
          : original.slice(0, n)
        out = out.slice(0, start) + back + out.slice(start + n)
        from = start + back.length
      } else {
        from = start
      }
    }
  }
  return out
}
