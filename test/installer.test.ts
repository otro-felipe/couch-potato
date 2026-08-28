import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveChromeExtensionId,
  installNativeHost,
  nativeHostPaths,
  uninstallNativeHost,
} from "../scripts/native-host-installation.js";
import { parseExtensionId } from "../scripts/install-native-host.js";
import "../scripts/uninstall-native-host.js";

describe("macOS native host installation", () => {
  it("derives Chrome id and installs exact private files", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cp-install-"));
    const projectRoot = path.join(home, "repo");
    await mkdir(path.join(projectRoot, "dist", "extension"), {
      recursive: true,
    });
    await mkdir(path.join(projectRoot, "dist", "native-host"), {
      recursive: true,
    });
    const key = Buffer.from("stable-public-key").toString("base64");
    await writeFile(
      path.join(projectRoot, "dist", "extension", "manifest.json"),
      JSON.stringify({ key }),
    );
    await writeFile(
      path.join(projectRoot, "dist", "native-host", "main.js"),
      "// built",
    );
    const result = await installNativeHost({
      home,
      projectRoot,
      nodePath: "/absolute/node",
    });
    expect(result.extensionId).toBe(deriveChromeExtensionId(key));
    expect(result.extensionId).toMatch(/^[a-p]{32}$/);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${result.extensionId}/`,
    ]);
    expect(manifest.path).toBe(result.wrapperPath);
    expect((await stat(path.dirname(result.wrapperPath))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(result.wrapperPath)).mode & 0o777).toBe(0o700);
    expect(await readFile(result.wrapperPath, "utf8")).toContain(
      "exec '/absolute/node'",
    );
    expect(await uninstallNativeHost({ home })).toEqual({
      removedManifest: true,
      removedWrapper: true,
    });
    expect(await uninstallNativeHost({ home })).toEqual({
      removedManifest: false,
      removedWrapper: false,
    });
  });
  it("accepts a fixed id and validates all inputs", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cp-fixed-"));
    const projectRoot = path.join(home, "repo");
    await mkdir(path.join(projectRoot, "dist", "native-host"), {
      recursive: true,
    });
    await writeFile(
      path.join(projectRoot, "dist", "native-host", "main.js"),
      "// built",
    );
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    expect(
      (
        await installNativeHost({
          home,
          projectRoot,
          nodePath: "/node'quoted",
          extensionId,
        })
      ).extensionId,
    ).toBe(extensionId);
    expect(await readFile(nativeHostPaths(home).wrapperPath, "utf8")).toContain(
      `'"'"'`,
    );
    await expect(
      installNativeHost({
        home,
        projectRoot,
        nodePath: "/node",
        extensionId: "bad",
      }),
    ).rejects.toThrow("extension id");
    await expect(
      installNativeHost({
        home: ".",
        projectRoot,
        nodePath: "/node",
        extensionId,
      }),
    ).rejects.toThrow("absolute");
    expect(() => deriveChromeExtensionId("!!!")).toThrow("manifest key");
    expect(() => deriveChromeExtensionId("ab")).toThrow("manifest key");
    expect(() => parseExtensionId(["--extension-id"])).toThrow("requires");
    expect(parseExtensionId([])).toBeUndefined();
    expect(parseExtensionId(["--extension-id", extensionId])).toBe(extensionId);
    expect(nativeHostPaths(home).manifestPath).toContain(
      "NativeMessagingHosts",
    );
    await expect(uninstallNativeHost({ home: "." })).rejects.toThrow(
      "absolute",
    );
    const missingKeyHome = await mkdtemp(path.join(tmpdir(), "cp-key-"));
    const missingKeyRoot = path.join(missingKeyHome, "repo");
    await mkdir(path.join(missingKeyRoot, "dist", "extension"), {
      recursive: true,
    });
    await mkdir(path.join(missingKeyRoot, "dist", "native-host"), {
      recursive: true,
    });
    await writeFile(
      path.join(missingKeyRoot, "dist", "extension", "manifest.json"),
      "{}",
    );
    await writeFile(
      path.join(missingKeyRoot, "dist", "native-host", "main.js"),
      "// built",
    );
    await expect(
      installNativeHost({
        home: missingKeyHome,
        projectRoot: missingKeyRoot,
        nodePath: "/node",
      }),
    ).rejects.toThrow("fixed key");
    const blocked = nativeHostPaths(missingKeyHome);
    await mkdir(blocked.manifestPath, { recursive: true });
    await expect(
      uninstallNativeHost({ home: missingKeyHome }),
    ).rejects.toBeDefined();
  });
});
