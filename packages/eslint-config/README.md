# @porulle/eslint-config

Internal ESLint config presets for the monorepo. Three exports:

| Export | Use for |
|---|---|
| `@porulle/eslint-config/base` | shared rules for every package |
| `@porulle/eslint-config/next-js` | Next.js apps (`apps/fashion-starter`, `apps/web`) |
| `@porulle/eslint-config/react-internal` | React-only library packages (no Next.js runtime) |

## Usage

```js
// eslint.config.mjs in a package
import config from "@porulle/eslint-config/base";
export default config;
```

Marked `private: true` — internal-only.
