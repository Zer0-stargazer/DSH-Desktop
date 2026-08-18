# Security

This repository must never contain API keys, `config.json`, `dsh-home`, logs, or `%APPDATA%` copies.

## Report a window / packaging issue

Email **gl20070126@gmail.com**. Do not attach keys. Use **Settings → Diagnostic** and send the exported report (keys are stripped).

## Report a kernel / agent / plugin issue

That is official DeepSeek Harness, not this window:

https://github.com/deepseek-ai/deepseek-harness/discussions

## What this app stores locally

| Item | Where | Notes |
| --- | --- | --- |
| API Key | `%APPDATA%\DSH Desktop\config.json` | Windows DPAPI (`safeStorage`) |
| Isolated sessions | `%APPDATA%\DSH Desktop\dsh-home` | Default; separate from `~/.dsh` |
| Shared sessions | `~/.dsh` | Only if you enable sharing |

The window does not upload keys. Official `dsh web` talks to model providers with the key you configured.

## Please do not

- Commit `vendor/node`, `dist/`, or Electron user-data folders
- Paste `keyEnc` / `keyPlain` / `.credentials.yaml` into issues
- Run official `dsh web` and this app against the same home at the same time
