/**
 * Tier 0  --  Binary file detection.
 *
 * Identifies binary files by extension. Default behavior is hash-only:
 * "changed" or "unchanged" plus byte-size delta.
 * Format-specific intelligence (image, audio, ELF) is a plugin surface.
 */

import type { EditAction } from "@ossl-dev/differens-core";

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "webm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "o",
  "a",
  "pdf",
  "zip",
  "tar",
  "gz",
  "7z",
  "bz2",
  "xz",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
]);

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * A format-aware binary diff.
 *
 * Programmatic plugin surface, on purpose: registering a plugin in-process is
 * all the engine needs, and dynamic loading from disk belongs to a plugin
 * ecosystem (phase 5), not to the diff pipeline.
 */
export interface BinaryDiffPlugin {
  /** Unique id, used for unregistering and in messages. */
  id: string;
  /** Extensions this plugin claims, lowercase without the dot. */
  extensions: string[];
  /**
   * Diff two binary files. Return actions, or undefined to decline (magic
   * bytes say this is not the format after all) and let the next plugin try.
   */
  diff(oldBytes: Uint8Array, newBytes: Uint8Array): EditAction[] | undefined;
}

const plugins: BinaryDiffPlugin[] = [];

export function registerBinaryPlugin(plugin: BinaryDiffPlugin): void {
  plugins.push(plugin);
}

/** Remove a plugin by id. Returns false when it was not registered. */
export function unregisterBinaryPlugin(id: string): boolean {
  const index = plugins.findIndex((p) => p.id === id);
  if (index < 0) return false;
  plugins.splice(index, 1);
  return true;
}

/** Plugins for an extension, first registered first. */
export function binaryPluginsFor(extension: string): BinaryDiffPlugin[] {
  const ext = extension.toLowerCase();
  return plugins.filter((p) => p.extensions.includes(ext));
}
