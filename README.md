# cmd-i18n：Claude Code 界面中文化

把 Claude Code 的**斜杠命令菜单、`/help`、`/config`、命令输出和等待界面**显示成中文。

只改界面上**画出来的文字**。命令名、设置项、`settings.json`、对话记录，以及**模型看到的内容都保持英文原文**，所以不影响 skill 的触发，也不影响模型的行为。

## 安装

需要 Claude Code 2.1.275 或更新版本（终端里执行 `claude --version` 查看）。

**在 Claude Code 会话里**（推荐），在输入框粘贴这一行，回车：

```
/plugin install cmd-i18n --marketplace AK-103U/claude-code-cmd-i18n
```

接下来会依次看到：

1. `Add marketplace?`：输入 `y`。
2. 选择安装范围：直接回车（`user`，所有项目都生效）。
3. 设置页：不确定就保持默认，直接继续。
4. 看到 `Installed cmd-i18n. Plugin is now active.` 就装好了，当前会话立即生效。

**在终端（shell）里**：

```
claude plugin install cmd-i18n --marketplace AK-103U/claude-code-cmd-i18n
```

**在桌面 App 里**（`/plugin` 命令不可用）：点输入框旁边的 **+** → **Plugins** → **Add marketplace**，填 `AK-103U/claude-code-cmd-i18n` → **Add plugin**。

装好后输入 `/` 看看命令菜单，或者执行 `/i18n` 查看状态。

## 更新

```
claude plugin marketplace update cmd-i18n
claude plugin update cmd-i18n@cmd-i18n
```

更新完重启 Claude Code，或在会话里执行 `/reload-plugins`。你自己的译文存在插件数据目录里，更新不会丢。

## 卸载

```
claude plugin uninstall cmd-i18n@cmd-i18n --keep-data
```

`--keep-data` 会保留你的本地词典，以后重装还能接着用。不加这个参数，本地词典会一起删掉。

## 会翻译哪些地方

| 位置 | 显示成中文的内容 | 会不会调用模型 |
|---|---|---|
| 命令菜单（输入 `/` 时）、`/help` | 命令描述 | 内置词典里没有的，后台补翻**一次**并存起来 |
| `/config` | 每行的标签，以及插件设置项的说明 | 同上 |
| 命令打印在对话里的输出行（`/compact`、`/model sonnet` 等） | 输出文字 | **从不**，只查词典 |
| 等待界面 | 状态文字（"Compacting conversation…"）、随机动词、回合结束的"琢磨了" | **从不**，只查词典 |

**关于 token 消耗**：内置词典已经覆盖 Claude Code 自带的命令和设置。你装的其他插件和 skill 的描述内置词典里可能没有，mod 会在后台用 `haiku` 翻译一次，写进你的本地词典，同一句话以后不会再请求模型。不想花 token，可以在 `/config` 里关掉 `autoTranslate`，没有译文的条目会保持英文。

## 命令

| 命令 | 作用 |
|---|---|
| `/i18n` 或 `/i18n status` | 查看状态：覆盖率、本地词典的路径和条数、本会话模型用量、还没有译文的条目、常见未命中 |
| `/i18n off` / `/i18n on` | 临时恢复英文 / 重新显示中文 |
| `/i18n refresh` | 重新读入词典（手改本地词典后立即生效），并补翻缺失的条目 |

## 设置（`/config` 里搜 cmd-i18n）

| 设置 | 默认值 | 说明 |
|---|---|---|
| `display` | `translation` | `translation` 只显示译文；`bilingual` 显示"译文 · 英文原文" |
| `autoTranslate` | 开 | 内置词典没有的条目要不要用模型补翻 |
| `model` | `haiku` | 补翻用的模型，填别名或完整模型 ID |

## 自己改译文：本地词典

觉得哪条译文不顺眼，或者想补一条，就改**本地词典**。执行 `/i18n status`，"本地词典"那一行会显示文件路径，一般是：

```
~/.claude/plugins/data/cmd-i18n-cmd-i18n/local.zh-CN.json
```

这是一个 `{ "英文原文": "中文译文" }` 的 JSON 文件，查词时**最先查它**：

- 想改掉内置的译文：加一条英文完全相同的条目，你的优先。
- 值写成空字符串 `""`：这条不显示译文，也不再请求模型。
- 模型补翻的结果会自动追加进来。写入前会先重新读文件，只补缺的条目，你手改的不会被冲掉。
- 改完执行 `/i18n refresh` 立即生效，不用重启。
- 文件格式写坏了：mod 会暂停写入（新译文只在本会话显示），`/i18n status` 会提示；改好后再执行 `/i18n refresh`。

这个文件在插件数据目录里，**更新 mod 不会覆盖它**。

## 做不到的地方

- 面板类命令（`/status`、`/usage`、`/model` 选择器、`/mcp`、`/plugin` 等）的内部文字写死在 Claude Code 里，mod 改不了。
- 等待行后面的 `for 1m 4s`、`(12s · ↓ 300 tokens · esc to interrupt)` 是 Claude Code 自己拼的，所以会显示成"琢磨了 for 1m 4s"。Tip 行可以用官方设置 `spinnerTipsOverride` 改。
- `/config` 搜索：中文能搜到；英文搜索大多能靠设置 key 命中，但只出现在英文标签里的词（如 cloud、terminal）会搜不到。

## 常见问题

**装完没变化？** 先执行 `/i18n status`。没有这个命令，说明 mod 没加载：在 `/plugin` 里确认 cmd-i18n 已启用，再确认 Claude Code 版本够新。

**想同时看英文原文？** 在 `/config` 里把 `display` 改成 `bilingual`。

**会不会影响 Claude 理解命令？** 不会。发给模型的 skill 列表会被换回英文原文，`/i18n status` 里能看到还原次数。

---

## 维护者说明

### 目录结构

| 路径 | 内容 |
|---|---|
| `hooks/register.ts` | 所有 hook、`/i18n` 命令、词典读写 |
| `hooks/core.ts` | 纯逻辑：查词、模板、命令输出翻译、skill 列表还原（不碰 `$`，便于单测） |
| `hooks/dict.ts` | 基础词典，导入时的只读快照，**不要改** |
| `dict/zh-CN.json` | **内置译文都在这里补和改**，同一句以它为准，会覆盖基础词典 |
| `hooks/verbs.ts` | 等待界面的中文动词 |
| `hooks/*.test.ts(x)` | 测试 |
| `.claude-plugin/plugin.json` | 插件清单，版本号在这里 |
| `.claude-plugin/marketplace.json` | 让本仓库能被 `/plugin install --marketplace` 安装 |

查词顺序：本地词典（使用者的数据目录）→ `dict/zh-CN.json` → `hooks/dict.ts` → 模板（含 `${...}` 的条目）。

### 本地开发

```
git clone https://github.com/AK-103U/claude-code-cmd-i18n.git
claude --plugin-dir ./claude-code-cmd-i18n
```

也可以在 `~/.claude/settings.json` 的 `env` 里加 `"CLAUDE_CODE_PLUGIN_DIRS": "<仓库的绝对路径>"`，以后每次启动都加载。保存文件会自动热重载。**开发时不要再从 marketplace 安装同一个 mod**，否则会加载两份。

开发加载时，本地词典在 `~/.claude/plugins/data/cmd-i18n-inline/local.zh-CN.json`。

### 测试

```
claude plugin test .
claude plugin validate .
```

### 把补翻的结果收进内置词典

你自己使用时补翻出来的译文在本地词典里。觉得质量可以，就合并进 `dict/zh-CN.json`，让所有人都能用：

```
jq -S -s '.[0] * .[1]' dict/zh-CN.json ~/.claude/plugins/data/cmd-i18n-inline/local.zh-CN.json > /tmp/zh-CN.json \
  && mv /tmp/zh-CN.json dict/zh-CN.json
```

合并后先检查 diff。确认没问题后，可以把本地词典清空成 `{}`。

### 发布新版本

1. 把 `.claude-plugin/plugin.json` 里的 `version` 加一（比如 `0.2.0` → `0.2.1`）。不改版本号，使用者更新时识别不到新版本。
2. 跑测试和 validate。
3. 提交并推送，再执行 `claude plugin tag --push` 打上 `cmd-i18n--v<版本>` 标签（可选，方便回溯）。

## 词典来源与许可

本 mod 以 MIT 协议发布，见 `LICENSE`。

基础词典 `hooks/dict.ts` 的条目，以及 `hooks/verbs.ts` 里等待中的中文动词（`SPINNER_VERBS`），于 2026-11-22 一次性导入自 [claude-code-zh-cn](https://github.com/taekchef/claude-code-zh-cn) 2.22.0（MIT License，Copyright (c) 2026 taekchef）。此后由本 mod 自行维护，**运行时不依赖该插件**。回合结束的过去式（`DONE_VERBS`）和 `dict/zh-CN.json` 由本 mod 自拟。许可全文见 `THIRD_PARTY_NOTICES.md`。
