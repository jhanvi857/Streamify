import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    "raw-uploads": { access: "private" },
    "hls-streams": { access: "private" },
  },
});
