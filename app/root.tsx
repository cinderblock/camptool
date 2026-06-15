import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import type { Route } from "./+types/root";

// Mantine's body background only resolves once its CSS + ColorSchemeScript run.
// On a dark-mode device that's a visible white flash. This inline <style> paints
// the right background on the very first paint, before any JS or external CSS.
// `color-scheme` tells the browser to render scrollbars/form controls in the
// matching scheme. The media query is the no-JS / pre-script baseline, and the
// data-attribute rules let Mantine's explicit choice (set by ColorSchemeScript
// synchronously, before paint) override the system preference — without them, a
// dark-system user who picks Mantine light gets a dark html peeking around the
// white body. Colors mirror Mantine's body defaults (`--mantine-color-body`):
// #fff in light, --mantine-color-dark-7 (#242424) in dark — keep them in sync
// if Mantine ever changes the dark body shade.
const earlyColorSchemeCss = `
:root { color-scheme: light dark; }
html { background-color: #ffffff; }
@media (prefers-color-scheme: dark) {
  html { background-color: #242424; }
}
html[data-mantine-color-scheme="light"] { background-color: #ffffff; }
html[data-mantine-color-scheme="dark"] { background-color: #242424; }
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <ColorSchemeScript defaultColorScheme="auto" />
        <style>{earlyColorSchemeCss}</style>
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          <Notifications position="top-right" />
          {children}
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "An unexpected error occurred.";
  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = error.data?.toString() ?? "";
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <main
      style={{
        padding: "2rem",
        fontFamily: "system-ui",
        color: "var(--mantine-color-text)",
        backgroundColor: "var(--mantine-color-body)",
        minHeight: "100vh",
      }}
    >
      <h1>{title}</h1>
      <p>{detail}</p>
    </main>
  );
}
