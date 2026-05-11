# @porulle/typescript-config

Internal TypeScript config presets for the monorepo (`base.json`, `nextjs.json`, `react-library.json`).

## Usage

```jsonc
// tsconfig.json in a package
{
  "extends": "@porulle/typescript-config/base.json",
  "compilerOptions": { "outDir": "dist" },
  "include": ["src/**/*"]
}
```

Marked `private: true` — internal-only.
