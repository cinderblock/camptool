/**
 * On the install a camp left: where it went (plans/camp-portability.md,
 * "Forwarding old links"). Old links for the camp land here when the browser
 * isn't signed in. Signing in here once (any way that works here) carries
 * the sign-in to the new site; or just go there.
 */
import {
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { data, redirect } from "react-router";
import { handoffUrl } from "~/lib/camp-move/handoff.server";
import { findMoveOut } from "~/lib/camp-move/move-out.server";
import { getRealSession } from "~/lib/session.server";
import type { Route } from "./+types/moved.$moveId";

export function meta(_: Route.MetaArgs) {
  return [{ title: "This camp has moved · CampTool" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const move = await findMoveOut(params.moveId);
  const live =
    move?.state === "done" &&
    !!move.targetCampUrl &&
    (move.windowEndsAt?.getTime() ?? 0) > Date.now();
  if (!move || !live || !move.targetCampUrl) {
    throw data("Not found", { status: 404 });
  }
  // Only somewhere on the camp's new site.
  const raw = new URL(request.url).searchParams.get("next");
  let next = move.targetCampUrl;
  try {
    if (raw && new URL(raw).origin === new URL(move.targetCampUrl).origin) {
      next = raw;
    }
  } catch {}
  const session = await getRealSession(request);
  if (session) {
    const signed = await handoffUrl(move, session.user.id, next);
    if (signed) throw redirect(signed);
  }
  const here = new URL(request.url);
  return {
    campName: move.campName,
    next,
    newHost: new URL(move.targetCampUrl).host,
    signedInElsewhere: !!session,
    login: `/login?next=${encodeURIComponent(here.pathname + here.search)}`,
  };
}

export default function CampMoved({ loaderData }: Route.ComponentProps) {
  const { campName, next, newHost, signedInElsewhere, login } = loaderData;
  return (
    <Container component="main" id="main-content" size={480} py="xl">
      <Title order={1} size="h2" ta="center">
        {campName} has moved
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Stack>
          <Text>
            {campName} moved to <Anchor href={next}>{newHost}</Anchor>.
          </Text>
          {!signedInElsewhere && (
            <Text size="sm" c="dimmed">
              Sign in here once to transfer your session and set up a passkey at
              the new address.
            </Text>
          )}
          <Group justify="flex-end">
            {!signedInElsewhere && (
              <Button component="a" href={login} variant="light">
                Sign in here first
              </Button>
            )}
            <Button component="a" href={next}>
              Go to {newHost}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
