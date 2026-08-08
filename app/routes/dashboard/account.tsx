/**
 * Your account — passkey management.
 *
 * The app had no passkey UI at all before this: the only way to enrol was a
 * card on the Overview that hardcoded the name "My device", with no list, no
 * rename and no delete. Passkeys becoming the primary way in (see
 * `plans/passkey-first-auth.md`) makes that untenable — you can't ask people to
 * rely on a credential they can't see or manage.
 *
 * Enrolment is client-side because it's a WebAuthn ceremony. Everything else
 * (list, rename, delete) is server-side so ownership and the last-passkey guard
 * are actually enforced rather than merely hidden in the UI.
 */
import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useState } from "react";
import { data, useFetcher, useRevalidator } from "react-router";
import { authClient } from "~/lib/auth-client";
import { redact } from "~/lib/privacy.server";
import { resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { passkey } from "../../../db/schema";
import type { Route } from "./+types/account";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Your account · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // resolveActiveCamp rather than requireUser: it works fine with no camp
  // (active is just null) and it's what carries the privacy lens. Passkey names
  // are user-authored labels and are on the redaction list.
  const { user, privacy } = await resolveActiveCamp(request);
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

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { passkeys } = loaderData;
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
      </Stack>
    </Container>
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
