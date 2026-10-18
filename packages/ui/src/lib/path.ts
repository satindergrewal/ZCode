const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const UNC_PATH_RE = /^\\\\/;
const URI_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;

export function getPathLeaf(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function getContainingDirectoryPath(path: string): string | null {
  const trimmedPath = path.trim().replace(/[\\/]+$/, "");
  if (!trimmedPath) {
    return null;
  }

  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? null;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}${trimmedPath[lastSeparatorIndex] ?? "\\"}`;
  }

  return parentPath || null;
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(path) || UNC_PATH_RE.test(path);
}

export function decodeFilePathUriEscapes(path: string): string {
  if (!URI_ESCAPE_RE.test(path)) {
    return path;
  }

  try {
    // Local file paths in markdown/tool output may already be URI-encoded -- a space in a
    // workspace name becomes %20. decodeURI restores the path text while keeping separator
    // escapes like %2F, so file name content is not split into extra path segments.
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function joinFilePath(basePath: string, childPath: string): string {
  if (!childPath) {
    return basePath;
  }

  if (isAbsoluteFilePath(childPath)) {
    return childPath;
  }

  const separator = basePath.includes("\\") && !basePath.includes("/") ? "\\" : "/";
  const normalizedBasePath = basePath.replace(/[\\/]+$/, "");
  const normalizedChildPath = childPath.replace(/^[\\/]+/, "");
  return `${normalizedBasePath}${separator}${normalizedChildPath}`;
}

// encodeURI leaves # and ? unescaped, yet both are URL fragment/query separators. With a # in
// the file name (index#v2.html) the resulting file URL gets its pathname truncated downstream
// (leaving /E:/dir/index) and the shell open fails; escape them after encodeURI.
function encodeUriPathForFileUrl(value: string): string {
  return encodeURI(value).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export function toFileUrl(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");

  if (WINDOWS_ABSOLUTE_PATH_RE.test(path)) {
    return `file:///${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  if (UNC_PATH_RE.test(path)) {
    return `file:${encodeUriPathForFileUrl(normalizedPath)}`;
  }

  return encodeUriPathForFileUrl(normalizedPath);
}
