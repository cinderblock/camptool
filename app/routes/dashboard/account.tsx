/**
 * Your account — passkey and password management.
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
import { auth } from "~/lib/auth.server";
import { redact } from "~/lib/privacy.server";
import { resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { account, passkey } from "../../../db/schema";
import type { Route } from "./+types/account";

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
  const { user, privacy, impersonatedBy } = await resolveActiveCamp(request);
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

  return redact(privacy, {
    hasPassword: await hasPasswordFor(user.id),
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
  const { passkeys, hasPassword, impersonating } = loaderData;
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
            Passkeys let you sign in with your face, fingerprint or device PIN.
            Nothing to remember, nothing to leak.
          </Text>
        </div>

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
                  <PasswordInput
                    name="newPassword"
                    label="New password"
                    autoComplete="new-password"
                    required
                  />
                  <PasswordInput
                    name="confirmPassword"
                    label="New password again"
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
