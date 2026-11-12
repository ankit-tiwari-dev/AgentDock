import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Serving the Next.js static export (`frontend/out`) safely. */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The decoded path, or undefined when it is not a valid percent-encoding or holds a NUL byte. */
export function decodePath(pathname: string): string | undefined {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function readFile(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    // Missing, a folder (EISDIR), or unreadable: all mean "not this one".
    return undefined;
  }
}

/** The file a URL path names inside one of `roots`, or `<path>/index.html`. Never anything outside a root. */
export function findExportFile(roots: string[], decodedPath: string): { path: string; body: Buffer } | undefined {
  for (const root of roots) {
    const base = resolve(root);
    const candidate = resolve(base, `.${decodedPath}`);
    const fromRoot = relative(base, candidate);
    // Outside the root: a parent folder, or (on Windows) another drive, which `relative` returns as an absolute path.
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue;
    for (const path of [candidate, join(candidate, "index.html")]) {
      const body = readFile(path);
      if (body) return { path, body };
    }
  }
  return undefined;
}

/** The contents of every `<script>` without a `src`, exactly as written, so each can be allowed by its hash. */
export function inlineScripts(html: string): string[] {
  const lower = html.toLowerCase();
  const found: string[] = [];
  let at = 0;
  for (;;) {
    const open = lower.indexOf("<script", at);
    if (open === -1) return found;
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) return found;
    const close = lower.indexOf("</script", tagEnd);
    if (close === -1) return found;
    const attributes = lower.slice(open + "<script".length, tagEnd);
    if (!/\bsrc\s*=/.test(attributes)) found.push(html.slice(tagEnd + 1, close));
    at = close + 1;
  }
}

/**
 * The page may run its own files and the inline scripts it shipped with, and talk only to this backend.
 * The two Google Fonts hosts are the stylesheet's font import.
 */
export function contentSecurityPolicy(html: string, port: number): string {
  const hashes = [...new Set(inlineScripts(html))].map(
    (script) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`,
  );
  // CSP source lists cannot hold an IPv6 literal such as [::1]; a page opened there still reaches its own host through 'self'.
  const sockets = ["127.0.0.1", "localhost"].map((host) => `ws://${host}:${port}`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${sockets.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
