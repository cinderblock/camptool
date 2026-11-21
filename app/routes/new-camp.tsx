/**
 * Starting a camp. Two ways in (plans/hosting-other-camps.md, step 9):
 *
 * - `/new-camp/:token`: a setup link a super admin sent to a camp lead. Works
 *   whatever the site's camp-creation lockdown says, and once only. The lead
 *   signs up or in right here if they need to.
 * - `/new-camp`: someone signed in, on a site that lets anyone start a camp
 *   (or a super admin). The home page shows the same form to someone in no
 *   camp yet, posting here.
 *
 * Either way the signed-in person becomes the camp's first admin and lands on
 * it. Lives outside the app shell so it stays on the apex.
 */
import { Alert, Container, Paper, Stack, Text, Title } from "@mantine/core";
import { eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import { AuthInline } from "~/components/AuthInline";
import { CreateCampForm } from "~/components/CreateCampForm";
import { discordEnabled, mailEnabled } from "~/lib/auth.server";
import {
  claimSetupLink,
  createCamp,
  findSetupLink,
  recordSetupLinkCamp,
  releaseSetupLink,
  type SetupLinkState,
  setupLinkState,
} from "~/lib/camp-admin.server";
import { campOrigin } from "~/lib/camp-host";
import { APEX, CAMP_SUBDOMAINS } from "~/lib/env.server";
import {
  getInstanceSettings,
  isSuperAdmin,
  setSignupUnlockCookie,
} from "~/lib/instance.server";
import { getRealSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { session as sessionTable } from "../../db/schema";
import type { Route } from "./+types/new-camp";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Start a camp · CampTool" }];
}

const STATE_MESSAGE: Record<Exclude<SetupLinkState, "ok">, string> = {
  used: "This link has already been used to start a camp.",
  revoked: "This link was withdrawn. Ask for a new one.",
  expired: "This link has expired. Ask for a new one.",
};

async function mayCreateWithoutLink(userId: string) {
  return (
    (await isSuperAdmin(userId)) ||
    (await getInstanceSettings()).allowCampCreation
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // The real session: a super admin working as someone shouldn't start a
  // camp in their name.
  const session = await getRealSession(request);
  const common = {
    apexHost: CAMP_SUBDOMAINS ? APEX.host : null,
    viewer: session ? { name: session.user.name } : null,
    discordEnabled,
    mailEnabled,
  };

  if (params.token) {
    const link = await findSetupLink(params.token);
    if (!link) throw data("Not found", { status: 404 });
    const state = setupLinkState(link);
    const payload = {
      ...common,
      state,
      withLink: true,
      fixedSlug: link.slug,
    };
    // Like a camp invite, a good link is a way in on an invite-only site.
    if (!session && state === "ok") {
      const { allowOpenSignups } = await getInstanceSettings();
      if (!allowOpenSignups) {
        return data(payload, {
          headers: { "Set-Cookie": setSignupUnlockCookie() },
        });
      }
    }
    return payload;
  }

  if (!session)
    throw redirect(`/login?next=${encodeURIComponent("/new-camp")}`);
  if (!(await mayCreateWithoutLink(session.user.id))) {
    throw data("Starting a camp here needs a setup link.", { status: 403 });
  }
  return {
    ...common,
    state: "ok" as SetupLinkState,
    withLink: false,
    fixedSlug: null as string | null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = await getRealSession(request);
  if (!session) {
    return data({ error: "Sign in first." }, { status: 401 });
  }
  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  let slug = String(form.get("slug") ?? "")
    .trim()
    .toLowerCase();

  let linkId: string | null = null;
  if (params.token) {
    const link = await findSetupLink(params.token);
    if (!link) throw data("Not found", { status: 404 });
    const state = setupLinkState(link);
    if (state !== "ok") {
      return data({ error: STATE_MESSAGE[state] }, { status: 400 });
    }
    if (!(await claimSetupLink(link.id, session.user.id))) {
      return data({ error: STATE_MESSAGE.used }, { status: 400 });
    }
    linkId = link.id;
    // The super admin picked the address; the form can't override it.
    if (link.slug) slug = link.slug;
  } else if (!(await mayCreateWithoutLink(session.user.id))) {
    return data(
      { error: "Starting a camp here needs a setup link." },
      { status: 403 },
    );
  }

  const made = await createCamp({
    userId: session.user.id,
    name,
    slug,
    linkId: linkId ?? undefined,
  });
  if (!made.ok) {
    if (linkId) await releaseSetupLink(linkId);
    return data({ error: made.error }, { status: 400 });
  }
  if (linkId) await recordSetupLinkCamp(linkId, made.campId);

  if (CAMP_SUBDOMAINS) {
    // The address decides the camp there (resolveActiveCamp).
    throw redirect(`${campOrigin(slug, APEX)}/`);
  }
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: made.campId })
    .where(eq(sessionTable.id, session.session.id));
  throw redirect("/");
}

export default function NewCamp({ loaderData, params }: Route.ComponentProps) {
  const { state, viewer, apexHost, withLink, fixedSlug } = loaderData;
  const action = params.token ? `/new-camp/${params.token}` : "/new-camp";

  return (
    <Container component="main" id="main-content" size={520} py="xl">
      <Title order={1} size="h2" ta="center">
        Start your camp
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        {state !== "ok" ? (
          <Alert color="red" title="Link unavailable">
            {STATE_MESSAGE[state]}
          </Alert>
        ) : !viewer ? (
          <AuthInline
            intro="First, make your account (or sign in). Then you'll name your camp and pick its address."
            discordEnabled={loaderData.discordEnabled}
            mailEnabled={loaderData.mailEnabled}
          />
        ) : (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              {withLink
                ? "You've been invited to start a camp on CampTool. "
                : ""}
              You'll be its first admin, as <b>{viewer.name}</b>, and can invite
              your campers from there.
            </Text>
            <CreateCampForm
              action={action}
              apexHost={apexHost}
              fixedSlug={fixedSlug}
            />
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
