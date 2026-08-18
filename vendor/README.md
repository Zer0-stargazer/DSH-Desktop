# Portable Node

Packaging copies `vendor/node/` into `resources/node/`. That Node runs official `dsh web`, not Electron's Node.

Do not commit `node.exe` or npm. Put a matching major version here before `npm run dist:dir`.

Expected layout:

```
vendor/node/node.exe
vendor/node/node_modules/npm/
```

Use the official Windows x64 zip from https://nodejs.org/dist/ (this repo was built against Node 24). Extract so `node.exe` sits in `vendor/node/`.
