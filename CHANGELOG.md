# Changelog

本仓库的版本指**窗口本身**（DSH Desktop）。里面的官方内核 `@deepseek-ai/dsh` 另有版本，在设置 → 内核里看，不跟这个号绑死。

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 启动自动更新默认关闭；更新失败提示改为人话；闪屏不再在未同步时写「同步完成」
- 首次 / 更新后第一次启动：闪屏说明会慢，并显示已等待时间
- 内核更新进度不再假停在 90%；显示已用时间。更新本身仍然很慢（依赖量大），条子偶尔会顿，已写入说明
- 关于 / README / 使用说明增加本仓库 Issues 作为窗口反馈入口

## [0.1.0] — 2026-08-18

第一份公开版。

### Added

- 用官方 `dsh web` 开独立窗口（无边框标题栏，跟随系统浅色 / 深色）
- 首次设置：API Key（本机 DPAPI）、数据目录、启动时同步 / 更新可勾选
- 默认 `DSH_HOME` 与 `~/.dsh` 隔离，设置里可选用同一份
- 合并网页端会话、标题、外接模型和缺的密钥
- 从 npm 同步官方内核：进度窗口、系统代理 / Clash 7897、失败可见、回滚到自带内核
- 设置分页：常规 / 内核 / 同步 / 社区 / 诊断
- 关于：个人开发者 Zer0、初心、声明
- 托盘；诊断导出（不含密钥）

[Unreleased]: https://github.com/Zer0-stargazer/DSH-Desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Zer0-stargazer/DSH-Desktop/releases/tag/v0.1.0
