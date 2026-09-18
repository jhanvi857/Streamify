<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Rules
- NEVER use emojis anywhere in this project (no emojis in UI, code, comments, terminal logs, or text). Always use clean SVG icons or text labels.

Set up this Neon project in the current working directory.

1. `npm i -g neon@latest && neon login`
2. `neon skills -y`
3. `neon mcp -y`
4. `neon link --project-id calm-pond-43880415 --branch production -y`
5. `neon config init`
6. Update `neon.ts`:

```ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    buckets: {
      "raw-uploads": { access: "private" },
      "hls-streams": { access: "private" },
    },
  },
});
```

7. `neon deploy`