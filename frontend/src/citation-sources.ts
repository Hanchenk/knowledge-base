import { fromMarkdown } from "mdast-util-from-markdown";
import type { Citation, WebSource } from "./types";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

function safeUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function sourceNumber(source: Citation | WebSource, index: number) {
  return Number.isInteger(source.citation_number) &&
    (source.citation_number || 0) > 0
    ? source.citation_number!
    : index + 1;
}

// The evidence ledger includes everything read, for permission checks and resume.
// Only references in the displayed answer belong in its source list.
export function visibleCitationSources(
  markdown: string,
  citations: Citation[],
  webSources: WebSource[] = [],
) {
  const knowledge = new Set<number>();
  const web = new Set<number>();
  const urls = new Set<string>();
  const definitions = new Map<string, string>();
  const root: MarkdownNode = fromMarkdown(markdown);
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier.toLowerCase(), node.url);
    node.children?.forEach(collectDefinitions);
  };
  collectDefinitions(root);
  const addUrl = (value: string) => {
    const url = safeUrl(value);
    if (url) urls.add(url);
  };
  const visit = (node: MarkdownNode) => {
    if (
      [
        "code",
        "inlineCode",
        "html",
        "image",
        "imageReference",
        "definition",
      ].includes(node.type)
    )
      return;
    if (node.type === "link" || node.type === "linkReference") {
      const destination =
        node.url || definitions.get(node.identifier?.toLowerCase() || "");
      if (destination) addUrl(destination);
      // Link labels such as [[3]](url) are not a numbered knowledge citation.
      return;
    }
    if (node.type === "text" && node.value) {
      for (const match of node.value.matchAll(/\[(W?)([1-9][0-9]*)\]/g))
        (match[1] === "W" ? web : knowledge).add(Number(match[2]));
      for (const match of node.value.matchAll(
        /https?:\/\/[^\s<>"'`。，；：！？）】》]+/gi,
      )) {
        let value = match[0];
        addUrl(value);
        // Prose punctuation is not part of the URL; retain exact URL variants too.
        while (/[.,;:!?\)\]\}。，；：！？）】》]$/.test(value)) {
          value = value.slice(0, -1);
          addUrl(value);
        }
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return {
    citations: citations
      .map((source, index) => ({
        ...source,
        citation_number: sourceNumber(source, index),
      }))
      .filter((source) => knowledge.has(source.citation_number)),
    webSources: webSources
      .map((source, index) => ({
        ...source,
        citation_number: sourceNumber(source, index),
      }))
      .filter((source) => {
        const url = safeUrl(source.url);
        return !!url && (web.has(source.citation_number) || urls.has(url));
      }),
  };
}
