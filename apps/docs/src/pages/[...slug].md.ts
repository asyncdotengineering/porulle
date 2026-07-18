import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

// Serve the raw Markdown source of every docs page at `/<slug>.md`, so readers
// (and LLMs / coding agents) can grab a clean copy. Powers the "View as Markdown"
// affordance and pairs with the generated /llms.txt.
export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const entry = props.entry as Awaited<ReturnType<typeof getCollection>>[number];
  const title = typeof entry.data.title === "string" ? entry.data.title : "";
  const body = entry.body ?? "";
  const markdown = title ? `# ${title}\n\n${body}` : body;
  return new Response(markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
