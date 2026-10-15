import type { Detail } from "./bot-types";

export type BotArtifact = Detail["artifacts"][number];
export type ArtifactPreviewKind =
  "html" | "markdown" | "text" | "image" | "pdf" | "file";

export function artifactPreviewKind(name: string): ArtifactPreviewKind {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["html", "htm", "svg"].includes(extension || "")) return "html";
  if (extension === "md") return "markdown";
  if (
    [
      "txt",
      "csv",
      "json",
      "py",
      "js",
      "ts",
      "css",
      "log",
      "xml",
      "yaml",
      "yml",
      "mjs",
      "cjs",
      "jsx",
      "tsx",
      "sql",
      "rs",
      "toml",
    ].includes(extension || "")
  )
    return "text";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension || ""))
    return "image";
  if (extension === "pdf") return "pdf";
  return "file";
}

export function artifactUrl(id: string, preview = false): string {
  return `/api/bot/artifacts/${encodeURIComponent(id)}${preview ? "/preview" : ""}`;
}

export function artifactRenderUrl(id: string, revision: string): string {
  return `${artifactUrl(id)}/render?revision=${encodeURIComponent(revision)}`;
}

/** Resolve only links to actual, visible task artifacts. Never guess a file ID. */
export function linkedArtifact(
  href: string,
  artifacts: BotArtifact[],
): BotArtifact | undefined {
  if (!href) return;
  let path = href;
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.origin !== window.location.origin) return;
      path = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return;
    }
  }
  const apiMatch = path.match(
    /^\/api\/bot\/artifacts\/([^/?#]+)(?:\/(?:preview|render))?(?:[?#].*)?$/,
  );
  if (apiMatch) {
    try {
      const id = decodeURIComponent(apiMatch[1]);
      return artifacts.find((file) => file.id === id);
    } catch {
      return;
    }
  }
  if (path.startsWith("sandbox:/mnt/data/"))
    path = path.slice("sandbox:/mnt/data/".length);
  else if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(path)) return;
  path = path.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return;
  }
  path = path.replace(/^(?:\.\/)+/, "");
  if (
    !path ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return;
  const exact = artifacts.filter((file) => file.name === path);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const basename = path.split("/").at(-1);
  const matches = artifacts.filter(
    (file) => file.name.split("/").at(-1) === basename,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
