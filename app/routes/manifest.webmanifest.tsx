import {
  getRealSession,
  loadUserCamps,
  requestCampSlug,
} from "~/lib/session.server";
import type { Route } from "./+types/manifest.webmanifest";

/**
 * Resource route: the web app manifest that makes CampTool installable to a
 * home screen (plans/pwa.md). Each address installs as its own app: a camp's
 * subdomain is named after the camp, the bare domain is "CampTool".
 *
 * Private first: the camp's name only goes to a signed-in member of it (the
 * page asks for this with credentials); anyone else gets the generic one.
 */

const APP_NAME = "CampTool";

/** A home-screen label: the part of a camp's name before " @ ", " - " etc. */
export function shortName(name: string): string {
  return name.split(/\s+[@|–—-]\s+/)[0]?.trim() || name;
}

async function campName(request: Request): Promise<string | null> {
  const slug = requestCampSlug(request);
  if (!slug) return null;
  const session = await getRealSession(request);
  if (!session) return null;
  const camps = await loadUserCamps(session.user.id);
  return camps.find((c) => c.camp.slug === slug)?.camp.name ?? null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const name = (await campName(request).catch(() => null)) ?? APP_NAME;
  const manifest = {
    id: "/",
    name,
    short_name: shortName(name),
    description: "Run your camp: who's coming, the map, dues and more.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Mantine's light body; the page's theme-color tags cover dark mode.
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Depends on who's asking.
      "Cache-Control": "private, no-cache",
    },
  });
}
