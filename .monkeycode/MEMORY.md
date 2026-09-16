# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[仓库独立性要求]
- Date: 2026-09-16
- Context: 用户明确要求项目必须是以自己名义存在的独立仓库，GitHub fork 关系需解除、代码不能全部呈现为他人成果
- Instructions:
  - 项目以独立仓库存在（非 GitHub fork 关联）：基于上游 mexiaosqwq/dsh-web-mobile（MIT）修改，由 multielement 维护；GitHub 上同名独立仓库 multielement/dsh-web-mobile，单初始提交历史
  - 仓库 README 需持续保持：项目来源声明（基于 mexiaosqwq/dsh-web-mobile MIT License 修改，由 multielement 维护）、本仓库的改动说明、免责声明（违规违法内容可经 GitHub Issues 联系删除）
  - LICENSE 保留上游版权行并追加 multielement 版权行；package.json 的 author/repository/homepage/bugs 指向 multielement/dsh-web-mobile
  - 新功能开发按规范走 .monkeycode/specs/<feature>/ 流程（requirements.md → design.md → tasklist.md）

[版本号与持续优化约定]
- Date: 2026-09-16
- Context: 用户指示对代码持续做优化改进并规定后续版本号规则
- Instructions:
  - 持续对代码做优化改进（每轮优化出一个新版本）
  - 后续版本号只递增最后一位：2.5.1、2.5.2、2.5.3 …（保持 2.5.x，不升 minor/major）
  - 每次发版同步更新 package.json version 与 README「更新内容」对应小节，改动走完整门禁（verify / test:core / build / diff --check）后提交推送

[推送提交需逐步说明]
- Date: 2026-09-16
- Context: 用户要求推送全部更新到仓库时提出
- Instructions:
  - 每次向仓库推送更新时，向用户逐步说明每一步操作及其结果

[DSHA 安全对齐结论]
- Date: 2026-09-16
- Context: Discovered by Agent while performing v2.5.2 host 半区安全加固（对照 DSHA 内置版取证）
- Category: Troubleshooting & Debugging
- Instructions:
  - DSHA（qiannianhuanxiang/DSHA）builtin-plugins 内 vendored 的 dsh-web-mobile 有加固版：插件自建路由跑宿主 requestRejection 鉴权（401|403）、4KB 请求体上限、aborted 处理；本地源码版三样全无——v2.5.2 已在 src/route-guard.ts 实现对齐（不依赖 DSHA 私有文件）
  - route-guard.ts 保持零相对运行时导入（全 DI），否则 node --test type-stripping 无法直测（.js 说明符映射回 .ts 只有 tsc bundler 模式支持）
  - DSHA vendored client.js 与本地 client.js 差异主要是插件安全加固，CSS 以 0.1.2+ 构建对 0.1.5-rc.2 大概率兼容但须实机实测；用户设备装 0.1.5-rc.2 后需验证
  - DSHA 私有 CSS 补丁已部分合入 v2.5.3：右栏 overlay（compat.css.ts）、toggle top 18px、composer 13px+delta（layout.css.ts）、inject 加 sidebar-right（package.json，peer optional）
  - DSHA 其余私有项暂未合入（见 AGENTS.md DSHA 0.1.5 适配补丁条目）：预设入口锚点、composer _modes 弹性族、删除确认底部弹层、backdrop 动画、icon-label 折叠族

