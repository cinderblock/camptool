/**
 * Camp wiki — pure helpers (see plans/camp-wiki.md). Client-safe: imported by
 * the wiki routes, the editor's link picker, and the map side panel.
 *
 * Two things live here:
 *  1. The SUBJECT registry — what a page can be "tied to" elsewhere in the app
 *     (a structure kind, a placed map object, a gathering, …).
 *  2. The BODY format — a small markdown subset parsed to a block/inline tree.
 *     It is deliberately parsed to a tree and rendered to React elements
 *     (components/WikiBody.tsx) rather than to an HTML string: member-authored
 *     text never goes near dangerouslySetInnerHTML in a multi-tenant SSR app.
 */
import { FEATURES, type FeatureKey } from "./features";

/* ------------------------------------------------------------------ slugs */

/** Title -> URL key. Also used to resolve `[[Page Title]]` links, so the two
 * can never drift apart. */
export function wikiSlug(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/* --------------------------------------------------------------- subjects */

/** What a wiki page can be attached to. Open-ended by design: the DB column is
 * text, so adding a subject kind is an entry here, not a migration. */
export type WikiSubjectType =
  | "structure_kind"
  | "map_object"
  | "gathering"
  | "offering"
  | "training"
  | "document";

export type WikiSubjectDef = {
  type: WikiSubjectType;
  /** Singular noun shown on the chip ("Structure", "Work party"). */
  label: string;
  /** Feature that must be visible for the subject to be reachable. */
  feature?: FeatureKey;
  /** Where the subject itself lives, given its id. */
  href: (id: string) => string;
};

export const WIKI_SUBJECTS: WikiSubjectDef[] = [
  {
    // The PRIMARY map tie. Keyed on Kind.value (e.g. "sierpinski-pyramid"), not
    // on a placed map_object row: campers re-declare their gear every year
    // (the re-commit model), so object rows are per-edition and disposable
    // while the kind — the thing worth documenting — is forever.
    type: "structure_kind",
    label: "Structure",
    feature: "map",
    href: () => "/map",
  },
  {
    // The per-instance escape hatch: THIS tent, this year.
    type: "map_object",
    label: "Placed object",
    feature: "map",
    href: (id) => `/map?object=${encodeURIComponent(id)}`,
  },
  {
    type: "gathering",
    label: "Gathering",
    feature: "schedule",
    href: (id) => `/schedule/${encodeURIComponent(id)}`,
  },
  {
    type: "offering",
    label: "Offering",
    feature: "programming",
    href: (id) => `/programming/${encodeURIComponent(id)}`,
  },
  {
    type: "training",
    label: "Sign-off",
    feature: "training",
    href: () => "/training",
  },
  {
    type: "document",
    label: "Document",
    feature: "documents",
    href: () => "/documents",
  },
];

const SUBJECTS_BY_TYPE = new Map(WIKI_SUBJECTS.map((s) => [s.type, s]));

export function wikiSubjectDef(type: string): WikiSubjectDef | undefined {
  return SUBJECTS_BY_TYPE.get(type as WikiSubjectType);
}

export function isWikiSubjectType(v: string): v is WikiSubjectType {
  return SUBJECTS_BY_TYPE.has(v as WikiSubjectType);
}

/* ------------------------------------------------- in-app link suggestions */

/** Destinations offered by the editor's "Insert link" picker, so linking to
 * another CampTool feature is a click rather than a memorized path. Core
 * surfaces first, then whichever features this camp can actually see. */
export function appLinkTargets(
  visibleFeatures: Iterable<FeatureKey>,
): Array<{ path: string; label: string }> {
  const visible = new Set(visibleFeatures);
  const core = [
    { path: "/", label: "Overview" },
    { path: "/guide", label: "How it works" },
    { path: "/members", label: "Members" },
    { path: "/editions", label: "Years" },
    { path: "/wiki", label: "Wiki" },
  ];
  // One entry per enabled feature, using the registry's own label + the route
  // the feature owns (its key is the path for all but these three).
  const pathFor: Partial<Record<FeatureKey, string>> = {
    bringing: "/bringing",
    recruiting: "/recruits",
    roster: "/roster",
  };
  const feature = FEATURES.filter((f) => visible.has(f.key)).map((f) => ({
    path: pathFor[f.key] ?? `/${f.key}`,
    label: f.label,
  }));
  return [...core, ...feature];
}

/* ----------------------------------------------------------- body: inline */

export type WikiInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: WikiInline[] }
  | { type: "em"; children: WikiInline[] }
  | { type: "code"; text: string }
  | {
      type: "link";
      /** "wiki" carries a slug; the others carry a ready-to-use href. */
      target: "wiki" | "internal" | "external";
      href: string;
      label: string;
    };

const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/;
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/;
const CODE_RE = /`([^`]+)`/;
const STRONG_RE = /\*\*([^*]+)\*\*/;
const EM_RE = /(?:\*([^*]+)\*|_([^_]+)_)/;

/** Resolve a `[[target]]` into a link node. `/path` = in-app, `http(s)://` =
 * external, anything else = another wiki page (by title or slug). */
export function resolveWikiTarget(
  rawTarget: string,
  rawLabel?: string,
): Extract<WikiInline, { type: "link" }> {
  const target = rawTarget.trim();
  const label = (rawLabel ?? "").trim() || target;
  if (/^https?:\/\//i.test(target)) {
    return { type: "link", target: "external", href: target, label };
  }
  if (target.startsWith("/")) {
    return { type: "link", target: "internal", href: target, label };
  }
  return { type: "link", target: "wiki", href: wikiSlug(target), label };
}

/**
 * Inline parse, innermost-last: each pass finds the earliest match of the
 * highest-precedence marker, then recurses on the text either side. Code spans
 * win over emphasis so `**` inside backticks stays literal.
 */
export function parseInline(src: string): WikiInline[] {
  if (!src) return [];

  const code = CODE_RE.exec(src);
  const link = LINK_RE.exec(src);
  const url = BARE_URL_RE.exec(src);
  const strong = STRONG_RE.exec(src);
  const em = EM_RE.exec(src);

  // Pick whichever construct starts earliest; ties break by this order.
  const candidates = [
    { m: code, kind: "code" as const },
    { m: link, kind: "link" as const },
    { m: url, kind: "url" as const },
    { m: strong, kind: "strong" as const },
    { m: em, kind: "em" as const },
  ].filter((c): c is { m: RegExpExecArray; kind: typeof c.kind } => !!c.m);

  let best = candidates[0];
  if (!best) return [{ type: "text", text: src }];
  for (const c of candidates) if (c.m.index < best.m.index) best = c;

  const { m, kind } = best;
  const whole = m[0];
  const before = src.slice(0, m.index);
  const after = src.slice(m.index + whole.length);

  let node: WikiInline;
  switch (kind) {
    case "code":
      node = { type: "code", text: m[1] ?? "" };
      break;
    case "link":
      node = resolveWikiTarget(m[1] ?? "", m[2]);
      break;
    case "url":
      node = { type: "link", target: "external", href: whole, label: whole };
      break;
    case "strong":
      node = { type: "strong", children: parseInline(m[1] ?? "") };
      break;
    default:
      node = { type: "em", children: parseInline(m[1] ?? m[2] ?? "") };
      break;
  }

  return [...parseInline(before), node, ...parseInline(after)];
}

/* ------------------------------------------------------------ body: block */

export type WikiBlock =
  | { type: "heading"; level: 1 | 2 | 3; children: WikiInline[] }
  | { type: "paragraph"; children: WikiInline[] }
  | { type: "list"; ordered: boolean; items: WikiInline[][] }
  | { type: "quote"; children: WikiInline[] }
  | { type: "code"; text: string; lang: string | null }
  | { type: "hr" };

/** Parse a body into blocks. Unknown syntax degrades to plain paragraphs — a
 * wiki should never punish someone for typing prose. */
export function parseWikiBody(body: string): WikiBlock[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: WikiBlock[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(buf.join(" ")) });
    buf.length = 0;
  };

  const para: string[] = [];
  const lineAt = (n: number) => lines[n] ?? "";
  while (i < lines.length) {
    const trimmed = lineAt(i).trim();

    // Fenced code — consumed verbatim, no inline parsing inside.
    const fence = /^```\s*(\S+)?\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph(para);
      const lang = fence[1] ?? null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lineAt(i).trim())) {
        buf.push(lineAt(i));
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push({ type: "code", text: buf.join("\n"), lang });
      continue;
    }

    if (trimmed === "") {
      flushParagraph(para);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(para);
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph(para);
      blocks.push({
        type: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        children: parseInline((heading[2] ?? "").trim()),
      });
      i++;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph(para);
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lineAt(i).trim())) {
        buf.push(lineAt(i).trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseInline(buf.join(" ")) });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph(para);
      const ordered = !!numbered;
      const items: WikiInline[][] = [];
      while (i < lines.length) {
        const t = lineAt(i).trim();
        const m = ordered
          ? /^\d+[.)]\s+(.*)$/.exec(t)
          : /^[-*+]\s+(.*)$/.exec(t);
        if (!m) break;
        items.push(parseInline(m[1] ?? ""));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    para.push(trimmed);
    i++;
  }
  flushParagraph(para);
  return blocks;
}

/** Every wiki page this body links to, as slugs — powers red-links and the
 * "pages that link here" backlink list. */
export function wikiLinkSlugs(body: string): string[] {
  const out = new Set<string>();
  const walk = (nodes: WikiInline[]) => {
    for (const n of nodes) {
      if (n.type === "link" && n.target === "wiki") out.add(n.href);
      else if (n.type === "strong" || n.type === "em") walk(n.children);
    }
  };
  for (const b of parseWikiBody(body)) {
    if (b.type === "code" || b.type === "hr") continue;
    if (b.type === "list") for (const item of b.items) walk(item);
    else walk(b.children);
  }
  return [...out];
}

/** First non-heading prose, trimmed — the index page's one-line summary. */
export function wikiExcerpt(body: string, max = 140): string {
  for (const b of parseWikiBody(body)) {
    if (b.type !== "paragraph") continue;
    const text = inlineText(b.children).trim();
    if (!text) continue;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return "";
}

function inlineText(nodes: WikiInline[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.text;
      if (n.type === "code") return n.text;
      if (n.type === "link") return n.label;
      return inlineText(n.children);
    })
    .join("");
}
