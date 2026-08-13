import { describe, expect, it } from "bun:test";
import { createNode } from "@ossl-dev/differens-core";
import { isBinaryExtension, registerBinaryPlugin, unregisterBinaryPlugin } from "./binary";
import { diffWithTier } from "./index";

describe("isBinaryExtension", () => {
  it("recognizes image, audio, archive, font, and native extensions", () => {
    for (const ext of ["png", "jpg", "gif", "webp", "mp3", "zip", "gz", "wasm", "so", "ttf"]) {
      expect(isBinaryExtension(ext)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isBinaryExtension("PNG")).toBe(true);
    expect(isBinaryExtension("Zip")).toBe(true);
  });

  it("rejects text extensions", () => {
    for (const ext of ["ts", "json", "md", "txt", "html", ""]) {
      expect(isBinaryExtension(ext)).toBe(false);
    }
  });
});

describe("binary plugins", () => {
  it("routes matching extensions through a registered plugin", () => {
    registerBinaryPlugin({
      id: "fake-img",
      extensions: ["png"],
      diff: (oldBytes, newBytes) => {
        expect(Buffer.from(oldBytes).toString()).toBe("old-bytes");
        expect(Buffer.from(newBytes).toString()).toBe("new-bytes");
        return [
          {
            type: "Update",
            context: [],
            node: createNode({ kind: "image", label: "photo", byteRange: [0, 4] }),
            detail: { kind: "ValueChanged", from: "1x1", to: "2x2" },
          },
        ];
      },
    });
    try {
      const result = diffWithTier("old-bytes", "new-bytes", "a.png", "a.png");
      expect(result.changes).toHaveLength(1);
      const change = result.changes[0]!;
      expect(change.type).toBe("Update");
      if (change.type === "Update" && change.detail.kind === "ValueChanged") {
        expect(change.detail.from).toBe("1x1");
      }
    } finally {
      unregisterBinaryPlugin("fake-img");
    }
  });

  it("falls back to the default hash diff when a plugin declines", () => {
    registerBinaryPlugin({
      id: "picky",
      extensions: ["png"],
      diff: () => undefined,
    });
    try {
      const result = diffWithTier("aaa", "bbbb", "a.png", "a.png");
      expect(result.changes).toHaveLength(1);
      const change = result.changes[0]!;
      expect(change.type).toBe("Update");
      if (change.type === "Update" && change.detail.kind === "ValueChanged") {
        expect(change.detail.from).toBe("3 bytes");
        expect(change.detail.to).toBe("4 bytes");
      }
    } finally {
      unregisterBinaryPlugin("picky");
    }
  });

  it("does not consult plugins for other extensions", () => {
    registerBinaryPlugin({
      id: "jpg-only",
      extensions: ["jpg"],
      diff: () => {
        throw new Error("jpg plugin must not be called for png files");
      },
    });
    try {
      const result = diffWithTier("aaa", "bbb", "a.png", "a.png");
      expect(result.changes).toHaveLength(1);
    } finally {
      unregisterBinaryPlugin("jpg-only");
    }
  });

  it("unregister removes the plugin and reports whether it existed", () => {
    registerBinaryPlugin({ id: "temp", extensions: ["bin"], diff: () => undefined });
    expect(unregisterBinaryPlugin("temp")).toBe(true);
    expect(unregisterBinaryPlugin("temp")).toBe(false);
  });
});
