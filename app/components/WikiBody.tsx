/**
 * Renders a wiki body (the markdown subset parsed in ~/lib/wiki) as React
 * elements. Deliberately NOT dangerouslySetInnerHTML — the body is written by
 * any member, and this is a multi-tenant SSR process.
 */
import { Anchor, Blockquote, Code, List, Text, Title } from "@mantine/core";
import { Link } from "react-router";
import type { WikiBlock, WikiInline } from "~/lib/wiki";

/**
 * `knownSlugs` — pages that exist, so `[[links]]` to unwritten ones render as
 * red-links. `wikiEnabled` — false when the reader's camp has the wiki turned
 * off (a FAQ answer can still be written in this format), in which case a
 * wiki-page link degrades to plain text rather than pointing at a gated route.
 */
type Ctx = { knownSlugs: Set<string>; wikiEnabled: boolean };

function InlineNodes({
  nodes,
  ctx,
}: {
  nodes: WikiInline[];
  ctx: Ctx;
}) {
  return (
    <>
      {nodes.map((node, i) => {
        // Index keys are correct here: the tree is re-parsed wholesale on every
        // body change, so there is no element identity to preserve.
        const key = i;
        switch (node.type) {
          case "text":
            return <span key={key}>{node.text}</span>;
          case "strong":
            return (
              <strong key={key}>
                <InlineNodes nodes={node.children} ctx={ctx} />
              </strong>
            );
          case "em":
            return (
              <em key={key}>
                <InlineNodes nodes={node.children} ctx={ctx} />
              </em>
            );
          case "code":
            return <Code key={key}>{node.text}</Code>;
          default: {
            if (node.target === "external") {
              return (
                <Anchor
                  key={key}
                  href={node.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {node.label}
                </Anchor>
              );
            }
            if (node.target === "internal") {
              return (
                <Anchor key={key} component={Link} to={node.href}>
                  {node.label}
                </Anchor>
              );
            }
            if (!ctx.wikiEnabled) {
              return (
                <Text key={key} component="span" c="dimmed">
                  {node.label}
                </Text>
              );
            }
            const exists = ctx.knownSlugs.has(node.href);
            return (
              <Anchor
                key={key}
                component={Link}
                to={`/wiki/${node.href}`}
                c={exists ? undefined : "dimmed"}
                fs={exists ? undefined : "italic"}
              >
                {node.label}
                {exists ? null : " (not written yet)"}
              </Anchor>
            );
          }
        }
      })}
    </>
  );
}

export function WikiBody({
  blocks,
  knownSlugs,
  wikiEnabled = true,
}: {
  blocks: WikiBlock[];
  knownSlugs: string[];
  wikiEnabled?: boolean;
}) {
  const ctx: Ctx = { knownSlugs: new Set(knownSlugs), wikiEnabled };
  return (
    <>
      {blocks.map((block, i) => {
        // Index keys are correct here: the tree is re-parsed wholesale on every
        // body change, so there is no element identity to preserve.
        const key = i;
        switch (block.type) {
          case "heading":
            return (
              <Title
                key={key}
                order={(block.level + 1) as 2 | 3 | 4}
                mt={i === 0 ? 0 : "lg"}
                mb="xs"
              >
                <InlineNodes nodes={block.children} ctx={ctx} />
              </Title>
            );
          case "paragraph":
            return (
              <Text key={key} mb="sm">
                <InlineNodes nodes={block.children} ctx={ctx} />
              </Text>
            );
          case "list":
            return (
              <List
                key={key}
                type={block.ordered ? "ordered" : "unordered"}
                mb="sm"
                spacing={4}
              >
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: parsed tree
                  <List.Item key={j}>
                    <InlineNodes nodes={item} ctx={ctx} />
                  </List.Item>
                ))}
              </List>
            );
          case "quote":
            return (
              <Blockquote key={key} mb="sm" p="sm">
                <InlineNodes nodes={block.children} ctx={ctx} />
              </Blockquote>
            );
          case "code":
            return (
              <Code key={key} block mb="sm">
                {block.text}
              </Code>
            );
          default:
            return <hr key={key} />;
        }
      })}
    </>
  );
}
