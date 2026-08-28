import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(repository, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "extension"), { recursive: true });

await build({
  entryPoints: [join(repository, "src/extension/background.ts")],
  outfile: join(output, "extension/background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome121",
  legalComments: "none",
});

await cp(
  join(repository, "src/extension/manifest.json"),
  join(output, "extension/manifest.json"),
);

await build({
  entryPoints: {
    "native-host/main": join(repository, "src/native-host/main.ts"),
    "client/index": join(repository, "src/client/index.ts"),
    "client/cli": join(repository, "src/client/cli.ts"),
    "scripts/install-native-host": join(
      repository,
      "scripts/install-native-host.ts",
    ),
    "scripts/uninstall-native-host": join(
      repository,
      "scripts/uninstall-native-host.ts",
    ),
  },
  outdir: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
});
