/**
 * Your account — who you are to the camp, plus credential management.
 *
 * Onboarding (`/start`) is a one-way corridor: it walks you through the asks
 * and then lets you out. Everything it collected then had no home afterwards,
 * so "I go by a different playa name now" or "my name is spelled wrong" had
 * nowhere to go. This page is that home — the durable, re-editable half of what
 * the wizard asks once.
 *
 * The app had no passkey UI at all before this: the only way to enrol was a
 * card on the Overview that hardcoded the name "My device", with no list, no
 * rename and no delete. Passkeys becoming the primary way in (see
 * `plans/passkey-first-auth.md`) makes that untenable — you can't ask people to
 * rely on a credential they can't see or manage.
 *
 * Enrolment is client-side because it's a WebAuthn ceremony. Everything else
 * (list, rename, delete, and every password operation) is server-side so
 * ownership and the safety guards are actually enforced rather than merely
 * hidden in the UI.
 *
 * The password card appears ONLY for accounts that already have a password.
 * There is deliberately no "add a password" — see
 * `plans/password-recovery.md` decision 1 — so the set of password-holders only
 * ever shrinks.
 */
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useState } from "react";
import {
  data,
  redirect,
  useFetcher,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { authClient } from "~/lib/auth-client";
import { auth, discordEnabled } from "~/lib/auth.server";
import { addToGroup, listGroups, removeFromGroup } from "~/lib/groups.server";
import { redact } from "~/lib/privacy.server";
import { resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  account,
  attendee,
  membership,
  passkey,
  user as userTable,
} from "../../../db/schema";
import type { Route } from "./+types/account";

type SerializedIdentity = Awaited<ReturnType<typeof loader>> extends {
  identity: infer I;
}
  ? I
  : never;

/** better-auth keeps the password hash on the account row whose providerId is
 * "credential"; OAuth accounts share the table with their own providerIds. */
const CREDENTIAL = "credential";

async function hasPasswordFor(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL)))
    .limit(1);
  return Boolean(row);
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Your account · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // resolveActiveCamp rather than requireUser: it works fine with no camp
  // (active is just null) and it's what carries the privacy lens. Passkey names
  // are user-authored labels and are on the redaction list.
  const { user, active, privacy, impersonatedBy } =
    await resolveActiveCamp(request);
  const keys = await db
    .select({
      id: passkey.id,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, user.id));

  // Discord is a linked identity on the same account, so it belongs here next
  // to the other credentials — and the "link your Discord" ask points at this
  // page, which means the control has to exist for anyone the ask reaches.
  const [discordAccount] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, user.id), eq(account.providerId, "discord")))
    .limit(1);

  // Who you are to THIS camp. Null when the account has no camp yet, in which
  // case the identity card simply doesn't render — there is no playa name
  // without a camp to have one in.
  const mid = active?.membership.id ?? null;
  const campId = active?.camp.id ?? null;

  const allGroups = campId ? await listGroups(campId) : [];

  // Their RSVP, so the card can say what it is and point at the one place that
  // changes it, rather than quietly duplicating the control.
  const [rsvp] = mid
    ? await db
        .select({ status: attendee.status })
        .from(attendee)
        .where(eq(attendee.membershipId, mid))
        .limit(1)
    : [];

  return redact(privacy, {
    identity: active
      ? {
          name: user.name ?? "",
          email: user.email ?? "",
          playaName: active.membership.playaName ?? "",
          campName: active.camp.name,
          rsvp: rsvp?.status ?? "unknown",
        }
      : null,
    groups: allGroups.map((g) => ({
      id: g.id,
      name: g.name,
      mine: mid ? g.memberIds.includes(mid) : false,
      memberCount: g.memberIds.length,
    })),
    hasPassword: await hasPasswordFor(user.id),
    discordEnabled,
    discordLinked: Boolean(discordAccount),
    // Password controls are hidden (and refused server-side) while an officer
    // is "working as" someone — see the action for why that would be actively
    // dangerous rather than merely confusing.
    impersonating: Boolean(impersonatedBy),
    passkeys: keys
      .map((k) => ({
        id: k.id,
        name: k.name?.trim() || "Unnamed passkey",
        // "multiDevice" = synced through a provider keychain, so it survives
        // losing the device. Worth surfacing: it changes the recovery story.
        synced: k.deviceType === "multiDevice" || k.backedUp,
        // ISO, never locale-formatted.
        created: k.createdAt ? k.createdAt.toISOString().slice(0, 10) : null,
      }))
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "")),
  });
}

export async function action({ request }: Route.ActionArgs) {
  // Goes through resolveActiveCamp so privacy mode's write guard applies —
  // renaming or deleting a credential during a demo should be refused like any
  // other write.
  const session = await resolveActiveCamp(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");

  // Scope every mutation to the caller's OWN passkeys. Without the userId in
  // the predicate, any id would do.
  const owned = and(eq(passkey.id, id), eq(passkey.userId, session.user.id));

  // --- who you are to the camp -------------------------------------------
  if (intent === "saveIdentity") {
    if (!session.active) {
      return data({ error: "You're not in a camp yet." }, { status: 400 });
    }
    const name = String(form.get("name") ?? "").trim();
    if (!name)
      return data({ error: "A name can't be blank." }, { status: 400 });
    if (name.length > 120) {
      return data({ error: "That name is too long." }, { status: 400 });
    }
    const raw = String(form.get("playaName") ?? "").trim();
    if (raw.length > 60) {
      return data({ error: "That playa name is too long." }, { status: 400 });
    }
    // Same split as the wizard's profile step: the real name is on the shared
    // account, the playa name belongs to this camp's membership. Somebody in
    // two camps can be Bug in one of them and not the other.
    await db
      .update(userTable)
      .set({ name })
      .where(eq(userTable.id, session.user.id));
    await db
      .update(membership)
      .set({ playaName: raw || null })
      .where(eq(membership.id, session.active.membership.id));
    return data({ ok: true });
  }

  if (intent === "joinGroup" || intent === "leaveGroup") {
    if (!session.active) {
      return data({ error: "You're not in a camp yet." }, { status: 400 });
    }
    // Self-service only. Groups grant no authority, so a member managing their
    // OWN membership of one is the lightest possible thing — but it is still
    // scoped to themselves here; adding other people happens on /members.
    const groupId = String(form.get("groupId") ?? "");
    const campId = session.active.camp.id;
    const me = session.active.membership.id;
    if (intent === "joinGroup") {
      await addToGroup({
        campId,
        groupId,
        membershipIds: [me],
        addedByMembershipId: me,
      });
    } else {
      await removeFromGroup({ campId, groupId, membershipId: me });
    }
    return data({ ok: true });
  }

  if (intent === "rename") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return data({ error: "Give it a name." }, { status: 400 });
    if (name.length > 60) {
      return data({ error: "That name is too long." }, { status: 400 });
    }
    await db.update(passkey).set({ name }).where(owned);
    return data({ ok: true });
  }

  if (intent === "delete") {
    const mine = await db
      .select({ id: passkey.id })
      .from(passkey)
      .where(eq(passkey.userId, session.user.id));
    if (!mine.some((k) => k.id === id)) {
      return data({ error: "That passkey isn't yours." }, { status: 403 });
    }
    // Refuse to remove the only one. Add the replacement first — otherwise a
    // single click leaves the account with no passkey at all, which is exactly
    // the state the whole migration is trying to get people out of.
    if (mine.length <= 1) {
      return data(
        {
          error:
            "That's your only passkey. Add another one first, then remove this.",
        },
        { status: 400 },
      );
    }
    await db.delete(passkey).where(owned);
    return data({ ok: true });
  }

  // --- Password ------------------------------------------------------------
  //
  // auth.api.changePassword authenticates off the REAL better-auth session
  // cookie, but everything above this line operates on the EFFECTIVE user. For
  // an officer working as a member those differ, so a password change would
  // silently rewrite the officer's own password while the page showed the
  // member's name. Refuse outright rather than try to be clever: past this
  // guard the effective user is the real user, which is what the passkey count
  // below relies on too.
  if (intent === "change-password" || intent === "remove-password") {
    if (session.impersonatedBy) {
      return data(
        {
          error:
            "You're working as someone else. Stop doing that before changing password settings — they apply to YOUR account, not theirs.",
        },
        { status: 403 },
      );
    }
  }

  if (intent === "change-password") {
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");

    if (!currentPassword || !newPassword) {
      return data({ error: "Fill in both passwords." }, { status: 400 });
    }
    if (newPassword !== confirm) {
      return data({ error: "Those two don't match." }, { status: 400 });
    }

    let setCookie: string | null = null;
    try {
      // better-auth verifies the current password (scrypt) and re-hashes the
      // new one. Doing that by hand is how you end up writing a hash the
      // sign-in path can't read.
      //
      // returnHeaders, and forwarding the Set-Cookie below, is NOT optional:
      // revokeOtherSessions rotates the caller's own session token too, so
      // swallowing better-auth's response headers leaves the browser holding a
      // token that no longer exists. The symptom is being bounced to /login the
      // instant you successfully change your password.
      const { headers } = await auth.api.changePassword({
        body: { currentPassword, newPassword, revokeOtherSessions: true },
        headers: request.headers,
        returnHeaders: true,
      });
      setCookie = headers.get("set-cookie");
    } catch (e) {
      // Wrong current password lands here, as do the length bounds.
      const message =
        e && typeof e === "object" && "body" in e
          ? ((e.body as { message?: string })?.message ?? null)
          : null;
      return data(
        { error: message ?? "That current password isn't right." },
        { status: 400 },
      );
    }
    // Redirect rather than data(): a Set-Cookie on a `data()` response does not
    // survive React Router's document/data response handling, so the rotated
    // token never reached the browser and the user was silently signed out the
    // moment they succeeded. Redirect responses carry their headers verbatim.
    // Verified both ways — see plans/password-recovery.md.
    return redirect("/account?changed=1", {
      ...(setCookie ? { headers: { "Set-Cookie": setCookie } } : {}),
    });
  }

  if (intent === "remove-password") {
    // The guarantee: never leave an account with no working way in. A passkey
    // is the only thing that counts here — Discord can be revoked upstream by
    // someone we don't control, and magic link needs the mail transport this
    // deployment doesn't have (plans/password-recovery.md decision 2).
    const keys = await db
      .select({ id: passkey.id })
      .from(passkey)
      .where(eq(passkey.userId, session.user.id));
    if (keys.length === 0) {
      return data(
        {
          error:
            "Set up a passkey first — otherwise removing your password locks you out.",
        },
        { status: 400 },
      );
    }

    // Drop the credential row entirely rather than nulling the hash: a null
    // password on a live account row is a state better-auth's sign-in path has
    // to special-case, and "no credential account" is the state it already
    // understands (it's what a passkey-first signup produces).
    await db
      .delete(account)
      .where(
        and(
          eq(account.userId, session.user.id),
          eq(account.providerId, CREDENTIAL),
        ),
      );
    return data({ ok: true, message: "Password removed. Passkeys only now." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const {
    identity,
    groups,
    passkeys,
    hasPassword,
    impersonating,
    discordEnabled,
    discordLinked,
  } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function addPasskey() {
    setBusy(true);
    const res = await authClient.passkey.addPasskey({
      name: label.trim() || defaultDeviceName(),
    });
    setBusy(false);
    if (res?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't add that passkey",
        message: res.error.message ?? "The browser cancelled it.",
      });
      return;
    }
    setLabel("");
    notifications.show({ title: "Passkey added", message: "You're all set." });
    revalidate();
  }

  const err =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Container size="sm" py="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Your account</Title>
          <Text size="sm" c="dimmed">
            Your details, who you're grouped with, and how you sign in.
          </Text>
        </div>

        {identity ? <IdentityCard identity={identity} /> : null}
        {identity ? <GroupsCard groups={groups} /> : null}

        <Card withBorder>
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text fw={600}>Your passkeys</Text>
              <Badge variant="light" color={passkeys.length ? "green" : "red"}>
                {passkeys.length
                  ? `${passkeys.length} set up`
                  : "None set up yet"}
              </Badge>
            </Group>

            {passkeys.length === 0 ? (
              <Text size="sm" c="dimmed">
                You don't have a passkey yet. Add one below — it takes a few
                seconds and works on this device straight away.
              </Text>
            ) : (
              <Stack gap="xs">
                {passkeys.map((k) => (
                  <PasskeyRow
                    key={k.id}
                    pk={k}
                    canDelete={passkeys.length > 1}
                  />
                ))}
              </Stack>
            )}

            {err ? (
              <Text size="sm" c="red">
                {err}
              </Text>
            ) : null}

            <Group align="end" gap="sm">
              <TextInput
                label="Name this device"
                description="So you can tell your passkeys apart later"
                placeholder={defaultDeviceName()}
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Button onClick={addPasskey} loading={busy}>
                Add a passkey
              </Button>
            </Group>
          </Stack>
        </Card>

        {/* Only where the deployment actually has Discord OAuth configured —
            otherwise there is nothing to link to, and the ask that points here
            isn't shown either (see the "discord" capability in asks.ts). */}
        {discordEnabled ? (
          <DiscordCard linked={discordLinked} impersonating={impersonating} />
        ) : null}

        {/* No "add a password" counterpart on purpose: passwords are a legacy
            credential here, so this card can only ever appear for accounts that
            already have one (plans/password-recovery.md decision 1). */}
        {hasPassword ? (
          <PasswordCard
            canRemove={passkeys.length > 0}
            impersonating={impersonating}
          />
        ) : null}
      </Stack>
    </Container>
  );
}

/** Link (or confirm) the Discord identity on this account. Unlinking isn't
 * offered: Discord can be revoked from Discord's own side, and for a camp that
 * uses it for membership verification, a one-click unlink here is a foot-gun. */
function DiscordCard({
  linked,
  impersonating,
}: {
  linked: boolean;
  impersonating: boolean;
}) {
  return (
    <Card withBorder>
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text fw={600}>Discord</Text>
          <Badge variant="light" color={linked ? "green" : "gray"}>
            {linked ? "Linked" : "Not linked"}
          </Badge>
        </Group>
        {linked ? (
          <Text size="sm" c="dimmed">
            Your Discord account is linked. You can sign in with it, and the
            camp can match you to the person in its server.
          </Text>
        ) : impersonating ? (
          <Alert color="yellow">
            You're working as someone else. Linking Discord always applies to
            your own account, so it's unavailable here.
          </Alert>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              Discord is where the camp actually talks. Linking it lets the camp
              match your account to the person in its server — and gives you
              another way to sign in.
            </Text>
            <Group>
              <Button
                variant="light"
                color="indigo"
                onClick={() =>
                  authClient.linkSocial({
                    provider: "discord",
                    callbackURL: "/account",
                  })
                }
              >
                Link Discord
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}

function PasswordCard({
  canRemove,
  impersonating,
}: {
  canRemove: boolean;
  impersonating: boolean;
}) {
  // Its own fetcher so password errors don't render inside the passkey card.
  const fetcher = useFetcher<typeof action>();
  const [changing, setChanging] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const busy = fetcher.state !== "idle";
  // The action's return type is a union of several shapes; pull the two fields
  // out as plain strings rather than fighting the narrowing at every use site.
  const payload = fetcher.data as
    | { error?: string; message?: string }
    | undefined;
  const error = payload?.error ?? null;
  // A successful change REDIRECTS (it has to, to deliver the rotated session
  // cookie), so its confirmation arrives as a search param rather than in
  // fetcher.data. Removal doesn't rotate anything and answers inline.
  const [params, setParams] = useSearchParams();
  const message =
    payload?.message ??
    (params.get("changed") === "1"
      ? "Password changed. Other devices are signed out."
      : null);

  return (
    <Card withBorder>
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text fw={600}>Password</Text>
          <Badge variant="light" color="gray">
            Set
          </Badge>
        </Group>

        <Text size="sm" c="dimmed">
          A password is the part of your account somebody else can guess, phish,
          or find in an unrelated site's breach. A passkey can't be any of those
          things — once you have one, you don't need this.
        </Text>

        {impersonating ? (
          <Alert color="yellow">
            You're working as someone else. Password settings always apply to
            your own account, so they're unavailable here — stop working as them
            first.
          </Alert>
        ) : (
          <>
            {message ? <Alert color="green">{message}</Alert> : null}
            {error ? <Alert color="red">{error}</Alert> : null}

            {changing ? (
              <fetcher.Form
                method="post"
                onSubmit={() => setChanging(false)}
                key={message ?? "change"}
              >
                <input type="hidden" name="intent" value="change-password" />
                <Stack gap="sm">
                  <PasswordInput
                    name="currentPassword"
                    label="Current password"
                    autoComplete="current-password"
                    required
                  />
                  {/* Passphrases work as-is — never trimmed, 128 chars — but
                      nobody tries one unless told. Same copy as /reset. */}
                  <PasswordInput
                    name="newPassword"
                    label="New password or passphrase"
                    description="A few unrelated words — “rusty kettle dawn patrol” — beat one short mangled word. Spaces count."
                    autoComplete="new-password"
                    required
                  />
                  <PasswordInput
                    name="confirmPassword"
                    label="Type it again"
                    autoComplete="new-password"
                    required
                  />
                  <Text size="xs" c="dimmed">
                    Changing it signs you out on your other devices.
                  </Text>
                  <Group gap="sm">
                    <Button type="submit" loading={busy}>
                      Save new password
                    </Button>
                    <Button
                      variant="subtle"
                      type="button"
                      onClick={() => setChanging(false)}
                    >
                      Cancel
                    </Button>
                  </Group>
                </Stack>
              </fetcher.Form>
            ) : confirmingRemove ? (
              <Stack gap="sm">
                <Text size="sm">
                  Remove your password? You'll sign in with your passkey from
                  then on. An officer can issue you a reset link if you ever
                  need a password back.
                </Text>
                <Group gap="sm">
                  <Button
                    color="red"
                    loading={busy}
                    onClick={() => {
                      fetcher.submit(
                        { intent: "remove-password" },
                        { method: "post" },
                      );
                      setConfirmingRemove(false);
                    }}
                  >
                    Yes, remove it
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => setConfirmingRemove(false)}
                  >
                    Keep it
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Group gap="sm">
                <Button
                  variant="light"
                  onClick={() => {
                    // Clear the ?changed=1 confirmation so a second change
                    // doesn't open with a stale success banner above it.
                    if (params.has("changed")) setParams({}, { replace: true });
                    setChanging(true);
                  }}
                >
                  Change password
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  disabled={!canRemove}
                  onClick={() => setConfirmingRemove(true)}
                >
                  Remove password
                </Button>
              </Group>
            )}

            {/* Stated inline rather than as a tooltip so it's readable on a
                phone, same as the last-passkey note above. */}
            {!canRemove ? (
              <Text size="xs" c="dimmed">
                Set up a passkey before removing your password — otherwise you'd
                have no way to sign in.
              </Text>
            ) : null}
          </>
        )}
      </Stack>
    </Card>
  );
}

/**
 * Your name, your playa name, and a way back into the questionnaire.
 *
 * The RSVP is shown but not editable here on purpose: it lives on `/start`,
 * where changing it also re-shapes what else you're asked. Two controls for one
 * fact is how the pass ledger went wrong; a link is enough.
 */
function IdentityCard({
  identity,
}: {
  identity: NonNullable<SerializedIdentity>;
}) {
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState(identity.name);
  const [playaName, setPlayaName] = useState(identity.playaName);
  const dirty =
    name.trim() !== identity.name || playaName.trim() !== identity.playaName;

  const rsvpLabel: Record<string, string> = {
    coming: "Coming this year",
    maybe: "Maybe this year",
    not_coming: "Not this year",
    unknown: "Haven't said yet",
  };

  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Text fw={600}>Your details</Text>
          <Text size="xs" c="dimmed">
            How you appear to {identity.campName}. Change these any time — they
            were asked once during sign-up and this is where they live now.
          </Text>
        </div>

        <TextInput
          label="Name"
          description="Your real name, as the camp knows you"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={120}
        />
        <TextInput
          label="Playa name"
          description="Optional. Leave blank if you don't have one."
          placeholder="e.g. Bug"
          value={playaName}
          onChange={(e) => setPlayaName(e.currentTarget.value)}
          maxLength={60}
        />
        <TextInput
          label="Email"
          value={identity.email}
          readOnly
          description="Ask an officer if this needs to change"
        />

        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              {rsvpLabel[identity.rsvp] ?? "Haven't said yet"}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              component="a"
              href="/start"
            >
              Update your answers
            </Button>
          </Group>
          <Button
            disabled={!dirty || !name.trim()}
            loading={fetcher.state !== "idle"}
            onClick={() =>
              fetcher.submit(
                { intent: "saveIdentity", name, playaName },
                { method: "post" },
              )
            }
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

/**
 * The social groups you're in, and the ones you could join.
 *
 * Self-service, because a group grants no authority over anybody — the worst a
 * wrong one does is misfile you in the directory. Creating and renaming groups,
 * and putting *other* people in them, stays on /members.
 */
function GroupsCard({
  groups,
}: {
  groups: { id: string; name: string; mine: boolean; memberCount: number }[];
}) {
  const fetcher = useFetcher<typeof action>();
  const mine = groups.filter((g) => g.mine);
  const rest = groups.filter((g) => !g.mine);
  const busy = fetcher.state !== "idle";

  return (
    <Card withBorder>
      <Stack gap="md">
        <div>
          <Text fw={600}>Your groups</Text>
          <Text size="xs" c="dimmed">
            Families, couples, housemates, the people you've camped with for
            years. They shape how the roster reads — they grant nobody any
            authority over anybody.
          </Text>
        </div>

        {mine.length === 0 ? (
          <Text size="sm" c="dimmed">
            You're not in any groups yet.
          </Text>
        ) : (
          <Stack gap="xs">
            {mine.map((g) => (
              <Group key={g.id} justify="space-between" wrap="wrap">
                <Text size="sm">
                  {g.name}
                  <Text span size="xs" c="dimmed">
                    {" "}
                    · {g.memberCount}{" "}
                    {g.memberCount === 1 ? "person" : "people"}
                  </Text>
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  loading={busy}
                  onClick={() =>
                    fetcher.submit(
                      { intent: "leaveGroup", groupId: g.id },
                      { method: "post" },
                    )
                  }
                >
                  Leave
                </Button>
              </Group>
            ))}
          </Stack>
        )}

        {rest.length > 0 ? (
          <Group gap="xs" wrap="wrap" align="center">
            <Text size="xs" c="dimmed">
              Join:
            </Text>
            {rest.map((g) => (
              <Button
                key={g.id}
                size="compact-xs"
                variant="light"
                loading={busy}
                onClick={() =>
                  fetcher.submit(
                    { intent: "joinGroup", groupId: g.id },
                    { method: "post" },
                  )
                }
              >
                {g.name}
              </Button>
            ))}
          </Group>
        ) : null}

        <Text size="xs" c="dimmed">
          Need a group that doesn't exist yet, or want to add someone else?
          That's on the{" "}
          <Anchor href="/members" size="xs">
            members page
          </Anchor>
          .
        </Text>
      </Stack>
    </Card>
  );
}

function PasskeyRow({
  pk,
  canDelete,
}: {
  pk: { id: string; name: string; synced: boolean; created: string | null };
  canDelete: boolean;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pk.name);

  if (editing) {
    return (
      <Group gap="xs">
        <TextInput
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: 1 }}
          aria-label="Passkey name"
        />
        <Button
          size="xs"
          onClick={() => {
            fetcher.submit(
              { intent: "rename", id: pk.id, name },
              { method: "post" },
            );
            setEditing(false);
          }}
        >
          Save
        </Button>
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            setName(pk.name);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </Group>
    );
  }

  return (
    <Group justify="space-between" wrap="nowrap">
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {pk.name}
        </Text>
        <Text size="xs" c="dimmed">
          {pk.synced ? "Synced across your devices" : "This device only"}
          {pk.created ? ` · added ${pk.created}` : ""}
        </Text>
        {/* The reason Remove is unavailable is stated inline rather than in a
            tooltip, so it's readable on a phone. */}
        {!canDelete ? (
          <Text size="xs" c="dimmed">
            Your only passkey — add another before removing this one.
          </Text>
        ) : null}
      </div>
      <Group gap="xs" wrap="nowrap">
        <Button size="xs" variant="subtle" onClick={() => setEditing(true)}>
          Rename
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="red"
          disabled={!canDelete}
          onClick={() =>
            fetcher.submit({ intent: "delete", id: pk.id }, { method: "post" })
          }
        >
          Remove
        </Button>
      </Group>
    </Group>
  );
}

/** A best-effort human label so people aren't all staring at "My device". */
function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "My device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "My device";
}
