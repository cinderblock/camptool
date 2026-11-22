import {
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { data, Form, redirect } from "react-router";
import { AuthInline } from "~/components/AuthInline";
import { CampHero } from "~/components/CampHero";
import { PasskeyBrowserGate } from "~/components/PasskeyBrowserGate";
import { PasskeySetupGate } from "~/components/PasskeySetupGate";
import { discordEnabled, mailEnabled } from "~/lib/auth.server";
import { pageUrl } from "~/lib/camp-host";
import { assertNotMoving } from "~/lib/camp-move/move-out.server";
import {
  getInstanceSettings,
  setSignupUnlockCookie,
} from "~/lib/instance.server";
import {
  INVITE_STATE_MESSAGE,
  type InviteState,
  inviteState,
} from "~/lib/invite";
import {
  hasUserPasskey,
  passkeyGateError,
  requestInAppBrowser,
} from "~/lib/passkey-gate.server";
import { markProspectJoined } from "~/lib/prospects.server";
import { isMemberOf } from "~/lib/recruits.server";
import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { attendee, camp, campInvite, membership, user } from "../../db/schema";
import type { Route } from "./+types/i.$token";

export function meta({ loaderData: d }: Route.MetaArgs) {
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
      kind: campInvite.kind,
      promoteAttendeeId: campInvite.promoteAttendeeId,
      prospectId: campInvite.prospectId,
      maxUses: campInvite.maxUses,
      useCount: campInvite.useCount,
      expiresAt: campInvite.expiresAt,
      revokedAt: campInvite.revokedAt,
      campName: camp.name,
      logo: camp.logo,
      description: camp.description,
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
  const [session, { allowOpenSignups, allowPasswordLogin }] = await Promise.all(
    [getSession(request), getInstanceSettings()],
  );

  const [alreadyMember, hasPasskey] = session
    ? await Promise.all([
        isMemberOf(session.user.id, invite.campId),
        hasUserPasskey(session.user.id),
      ])
    : [false, false];

  const payload = {
    campName: invite.campName,
    logo: invite.logo,
    description: invite.description,
    // Only a personal link is "so-and-so invited you"; an open link is the
    // camp's door, not a person's.
    inviterName: invite.kind === "personal" ? invite.inviterName : null,
    state,
    viewer: session ? { name: session.user.name } : null,
    alreadyMember,
    hasPasskey,
    inAppBrowser: requestInAppBrowser(request),
    pageUrl: pageUrl(request.url).href,
    discordEnabled,
    mailEnabled,
    allowPasswordLogin,
  };

  // A valid invite is a sanctioned signup entry point. Only in invite-only mode
  // do we drop the signup-unlock cookie that lets a logged-out invitee create an
  // account; in open mode nothing is set so behavior is unchanged.
  if (!session && state === "ok" && !allowOpenSignups) {
    return data(payload, {
      headers: { "Set-Cookie": setSignupUnlockCookie() },
    });
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

  if (await isMemberOf(session.user.id, invite.campId)) throw redirect("/");
  await assertNotMoving(invite.campId);

  // Require a passkey before consuming the invite when passkey-only mode is
  // active, so a visitor in an in-app browser doesn't burn a one-use link.
  const { allowPasswordLogin } = await getInstanceSettings();
  const gateError = await passkeyGateError(
    request,
    session.user.id,
    allowPasswordLogin,
  );
  if (gateError) return data({ error: gateError }, { status: 400 });

  // Join directly. We bypass auth.api.addMember because that checks the
  // *caller's* camp permission, and the invitee has none yet — the valid token
  // is the authorization. Inserting here also lets us record the invite edge
  // atomically. Only a personal link records its inviter on the new membership;
  // an open link is the camp's door, so the invite tree gets no edge.
  const membershipId = crypto.randomUUID();
  await db.insert(membership).values({
    id: membershipId,
    organizationId: invite.campId,
    userId: session.user.id,
    role: invite.role,
    status: "active",
    invitedByMembershipId:
      invite.kind === "personal" ? invite.inviterMembershipId : null,
    // Both kinds record the door they came through — an open link carries no
    // personal inviter, but the link itself is still traceable.
    viaInviteId: invite.id,
  });

  // A promotion invite adopts the guest's attendee row: their RSVP, occupancy,
  // tickets, and passes all reference that row, so setting membership_id makes
  // everything follow into the new account. Host/name/email clear because a
  // member row resolves those from the account (guarded on it still being a
  // guest, in case someone re-links it in the meantime).
  if (invite.promoteAttendeeId) {
    await db
      .update(attendee)
      .set({
        membershipId,
        hostMembershipId: null,
        name: null,
        email: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(attendee.id, invite.promoteAttendeeId),
          eq(attendee.campId, invite.campId),
          isNull(attendee.membershipId),
        ),
      );
  }

  // An invite minted from a prospect's card closes the loop the other way:
  // the officers' conversation history stops being about a stranger and
  // becomes this member's history. See plans/prospects-crm.md.
  if (invite.prospectId) {
    await markProspectJoined({
      campId: invite.campId,
      prospectId: invite.prospectId,
      membershipId,
    });
  }

  await db
    .update(campInvite)
    .set({ useCount: sql`${campInvite.useCount} + 1`, lastUsedAt: new Date() })
    .where(eq(campInvite.id, invite.id));

  throw redirect("/");
}

export default function RedeemInvite({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    campName,
    logo,
    description,
    inviterName,
    state,
    viewer,
    alreadyMember,
    hasPasskey,
    inAppBrowser,
    pageUrl: url,
  } = loaderData;
  const actionError =
    actionData && "error" in actionData ? actionData.error : null;

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <CampHero
          name={campName}
          logo={logo}
          description={description}
          tagline={
            inviterName ? (
              <>
                <b>{inviterName}</b> invited you to join {campName}.
              </>
            ) : (
              <>You're invited to join {campName}.</>
            )
          }
        />

        <Paper withBorder radius="md" p="lg">
          <InviteBody
            campName={campName}
            state={state}
            viewer={viewer}
            alreadyMember={alreadyMember}
            hasPasskey={hasPasskey}
            inAppBrowser={inAppBrowser}
            pageUrl={url}
            actionError={actionError}
            discordEnabled={loaderData.discordEnabled}
            mailEnabled={loaderData.mailEnabled}
            allowPasswordLogin={loaderData.allowPasswordLogin}
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
  hasPasskey,
  inAppBrowser,
  pageUrl: url,
  actionError,
  discordEnabled,
  mailEnabled,
  allowPasswordLogin,
}: {
  campName: string;
  state: InviteState;
  viewer: { name: string } | null;
  alreadyMember: boolean;
  hasPasskey: boolean;
  inAppBrowser: Route.ComponentProps["loaderData"]["inAppBrowser"];
  pageUrl: string;
  actionError: string | null;
  discordEnabled: boolean;
  mailEnabled: boolean;
  allowPasswordLogin: boolean;
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
        <Anchor href="/">Go to your dashboard.</Anchor>
      </Alert>
    );
  }

  return (
    <PasskeyBrowserGate
      enabled={!allowPasswordLogin && (!viewer || !hasPasskey)}
      serverInApp={inAppBrowser}
      pageUrl={url}
      reassurance="Your invite link hasn't been used yet — it's still good."
    >
      {!viewer ? (
        <AuthInline
          intro={`Create an account to accept your invite to ${campName} — so you can sign back in later.`}
          discordEnabled={discordEnabled}
          mailEnabled={mailEnabled}
          allowPasswordLogin={allowPasswordLogin}
        />
      ) : !allowPasswordLogin && !hasPasskey ? (
        <PasskeySetupGate
          viewerName={viewer.name}
          nextStepLabel={`join ${campName}`}
          hasLink
        />
      ) : (
        <Form method="post">
          <Stack gap="md">
            {actionError ? <Alert color="red">{actionError}</Alert> : null}
            <Text size="sm" c="dimmed">
              Joining as <b>{viewer.name}</b>.
            </Text>
            <Group justify="flex-end">
              <Button type="submit">Join {campName}</Button>
            </Group>
          </Stack>
        </Form>
      )}
    </PasskeyBrowserGate>
  );
}
