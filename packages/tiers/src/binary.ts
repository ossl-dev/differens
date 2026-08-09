/**
 * Tier 0  --  Binary file detection.
 *
 * Identifies binary files by extension. Default behavior is hash-only:
 * "changed" or "unchanged" plus byte-size delta.
 * Format-specific intelligence (image, audio, ELF) is a plugin surface.
 */

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "mp3", "wav", "flac", "ogg", "mp4", "mov", "webm",
  "exe", "dll", "so", "dylib", "bin", "wasm", "o", "a",
  "pdf", "zip", "tar", "gz", "7z", "bz2", "xz",
  "ttf", "otf", "woff", "woff2", "eot",
]);

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase());
}
