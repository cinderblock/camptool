import {
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, eq, sql } from "drizzle-orm";
import { Form, data, redirect } from "react-router";
import { AuthInline } from "~/components/AuthInline";
import { discordEnabled } from "~/lib/auth.server";
import {
  getInstanceSettings,
  setSignupUnlockCookie,
} from "~/lib/instance.server";
import {
  INVITE_STATE_MESSAGE,
  type InviteState,
  inviteState,
} from "~/lib/invite";
import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { camp, campInvite, membership, user } from "../../db/schema";
import type { Route } from "./+types/i.$token";

export function meta({ data: d }: Route.MetaArgs) {
  const name = d?.campName ?? "Camp";
  return [{ title: `Join ${name} · CampTool` }];
}

async function findInvite(token: string) {
  const [row] = await db
    .select({
      id: campInvite.id,
      campId: campInvite.campId,
      inviterMembershipId: campInvite.inviterMembershipId,
      role: campInvite.role,
      maxUses: campInvite.maxUses,
      useCount: campInvite.useCount,
      expiresAt: campInvite.expiresAt,
      revokedAt: campInvite.revokedAt,
      campName: camp.name,
      logo: camp.logo,
      inviterName: user.name,
    })
    .from(campInvite)
    .innerJoin(camp, eq(campInvite.campId, camp.id))
    .innerJoin(membership, eq(campInvite.inviterMembershipId, membership.id))
    .innerJoin(user, eq(membership.userId, user.id))
    .where(eq(campInvite.token, token))
    .limit(1);
  return row;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const invite = await findInvite(params.token);
  if (!invite) throw data("Invite not found", { status: 404 });

  const state = inviteState(invite);
  const session = await getSession(request);

  let alreadyMember = false;
  if (session) {
    const [m] = await db
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.userId, session.user.id),
          eq(membership.organizationId, invite.campId),
        ),
      )
      .limit(1);
    alreadyMember = Boolean(m);
  }

  const payload = {
    campName: invite.campName,
    logo: invite.logo,
    inviterName: invite.inviterName,
    state,
    viewer: session ? { name: session.user.name } : null,
    alreadyMember,
    discordEnabled,
  };

  // A valid invite is a sanctioned signup entry point. Only in invite-only mode
  // do we drop the signup-unlock cookie that lets a logged-out invitee create an
  // account; in open mode nothing is set so behavior is unchanged.
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

export async function action({ request, params }: Route.ActionArgs) {
  const session = await getSession(request);
  if (!session) {
    return data({ error: "Please sign in to accept." }, { status: 401 });
  }

  const invite = await findInvite(params.token);
  if (!invite) throw data("Invite not found", { status: 404 });

  const state = inviteState(invite);
  if (state !== "ok") {
    return data({ error: INVITE_STATE_MESSAGE[state] }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.userId, session.user.id),
        eq(membership.organizationId, invite.campId),
      ),
    )
    .limit(1);
  if (existing) throw redirect("/dashboard");

  // Join directly. We bypass auth.api.addMember because that checks the
  // *caller's* camp permission, and the invitee has none yet — the valid token
  // is the authorization. Inserting here also lets us record the invite edge
  // atomically.
  await db.insert(membership).values({
    id: crypto.randomUUID(),
    organizationId: invite.campId,
    userId: session.user.id,
    role: invite.role,
    status: "active",
    invitedByMembershipId: invite.inviterMembershipId,
  });

  await db
    .update(campInvite)
    .set({ useCount: sql`${campInvite.useCount} + 1` })
    .where(eq(campInvite.id, invite.id));

  throw redirect("/dashboard");
}

export default function RedeemInvite({ loaderData }: Route.ComponentProps) {
  const { campName, logo, inviterName, state, viewer, alreadyMember } =
    loaderData;

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Stack gap="xs" align="center">
          {logo ? (
            <Image src={logo} alt={campName} w={96} h={96} radius="md" />
          ) : null}
          <Title order={1} ta="center">
            {campName}
          </Title>
          <Text c="dimmed" ta="center">
            <b>{inviterName}</b> invited you to join {campName}.
          </Text>
        </Stack>

        <Paper withBorder radius="md" p="lg">
          <InviteBody
            campName={campName}
            state={state}
            viewer={viewer}
            alreadyMember={alreadyMember}
            discordEnabled={loaderData.discordEnabled}
          />
        </Paper>
      </Stack>
    </Container>
  );
}

function InviteBody({
  campName,
  state,
  viewer,
  alreadyMember,
  discordEnabled,
}: {
  campName: string;
  state: InviteState;
  viewer: { name: string } | null;
  alreadyMember: boolean;
  discordEnabled: boolean;
}) {
  if (state !== "ok") {
    return (
      <Alert color="red" title="Invite unavailable">
        {INVITE_STATE_MESSAGE[state]}
      </Alert>
    );
  }

  if (alreadyMember) {
    return (
      <Alert color="green" title="You're in">
        You're already a member of {campName}.{" "}
        <Anchor href="/dashboard">Go to your dashboard.</Anchor>
      </Alert>
    );
  }

  if (!viewer) {
    return (
      <AuthInline
        intro={`Create an account to accept your invite to ${campName} — it lets you set a password and sign back in later.`}
        discordEnabled={discordEnabled}
      />
    );
  }

  return (
    <Form method="post">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Joining as <b>{viewer.name}</b>.
        </Text>
        <Group justify="flex-end">
          <Button type="submit">Join {campName}</Button>
        </Group>
      </Stack>
    </Form>
  );
}
