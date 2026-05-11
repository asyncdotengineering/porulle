# packages/skills

Claude Code [skills](https://docs.claude.com/en/docs/claude-code/skills) bundled with Porulle. Not a Node package — a directory of `SKILL.md` files that Claude Code loads when relevant.

## What's here

```
porulle/
├── SKILL.md         # the skill definition + trigger conditions
└── references/      # supporting docs Claude reads on activation
```

The `porulle` skill activates when an adopter is building a store, plugin, storefront, POS system, or marketplace using Porulle — including configuring `commerce.config.ts`, defining routes, writing hooks, setting up adapters, working with the SDK, or deploying. It teaches Claude the Porulle conventions (Drizzle-first, `Result<T>`, org-scoping, plugin manifest shape) so generated code matches the codebase.

## Installing the skill

Copy the `porulle/` directory into your Claude Code skills folder:

```bash
mkdir -p ~/.claude/skills
cp -r packages/skills/porulle ~/.claude/skills/
```

Claude Code picks it up on next session start.

## See also

- [Claude Code skills documentation](https://docs.claude.com/en/docs/claude-code/skills)
- [Plugin Contract](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/extending/plugin-contract.mdx) — the rules the skill enforces
