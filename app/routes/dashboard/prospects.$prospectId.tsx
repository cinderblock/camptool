/**
 * One prospect: their details, how to reach them, and the whole conversation
 * every officer has had with them. See plans/prospects-crm.md.
 *
 * The log is the point of the feature. An officer who gets a Facebook message
 * pastes it here — text, screenshot, and a link back to the original — and the
 * next officer to talk to that person can see it.
 */
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { DateInput, DateTimePicker } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { MarkupTextarea } from "~/components/MarkupTextarea";
import { WikiBody } from "~/components/WikiBody";
import { PUBLIC_BASE_URL } from "~/lib/env.server";
import { loadFeatureStates, requireFeature } from "~/lib/features.server";
import { newInviteToken } from "~/lib/invite.server";
import { mergeProspects } from "~/lib/merge.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  CHANNEL_OPTIONS,
  DIRECTION_OPTIONS,
  STATUS_OPTIONS,
  channelLabel,
  directionLead,
  isDirection,
  isProspectChannel,
  isProspectStatus,
  statusDef,
} from "~/lib/prospects";
import {
  loadProspectThread,
  loadProspects,
  officerNames,
} from "~/lib/prospects.server";
import { requireActiveCamp } from "~/lib/session.server";
import { displayUrl, normalizeUrl } from "~/lib/url";
import { type LinkTarget, appLinkTargets, parseWikiBody } from "~/lib/wiki";
import { db } from "../../../db/client.server";
import {
  campInvite,
  prospect,
  prospectHandle,
  prospectInteraction,
} from "../../../db/schema";
import type { Route } from "./+types/prospects.$prospectId";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `${d?.thread.prospect.name ?? "Prospect"} · CampTool` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "prospects");
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const campId = active.camp.id;

  const thread = await loadProspectThread(campId, params.prospectId);
  if (!thread) throw data("Prospect not found", { status: 404 });

  const [names, everyone, features] = await Promise.all([
    officerNames(campId),
    loadProspects(campId),
    loadFeatureStates(campId),
  ]);

  // The same link picker the wiki and FAQ editors use, so a note can point at
  // "[[/tickets]]" or a wiki page rather than describing where to look.
  const visible = new Set(
    [...features].filter(([, s]) => s !== "off").map(([k]) => k),
  );
  const linkTargets: LinkTarget[] = appLinkTargets(visible).map((t) => ({
    group: "CampTool",
    path: t.path,
    label: t.label,
    kind: "route" as const,
  }));

  return redact(privacy, {
    thread,
    officers: [...names].map(([value, label]) => ({ value, label })),
    others: everyone
      .filter((p) => p.id !== params.prospectId)
      .map((p) => ({
        value: p.id,
        label: p.playaName ? `${p.name} “${p.playaName}”` : p.name,
      })),
    linkTargets,
    inviteBaseUrl: PUBLIC_BASE_URL,
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  await requireFeature(active, "prospects");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers only." }, { status: 403 });
  }
  const campId = active.camp.id;
  const myMid = active.membership.id;
  const prospectId = params.prospectId;

  // Every mutation below is scoped by (id, campId), so an id from another camp
  // is simply not found rather than quietly editable.
  const [row] = await db
    .select({ id: prospect.id, name: prospect.name })
    .from(prospect)
    .where(and(eq(prospect.id, prospectId), eq(prospect.campId, campId)))
    .limit(1);
  if (!row) return data({ error: "Prospect not found." }, { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const touch = { updatedAt: new Date() };
  const str = (k: string, max = 500) =>
    String(form.get(k) ?? "")
      .trim()
      .slice(0, max) || null;

  if (intent === "updateDetails") {
    const name = str("name", 200);
    if (!name) return data({ error: "A name is required." }, { status: 400 });
    const statusRaw = String(form.get("status") ?? "");
    const ownerRaw = String(form.get("ownerMembershipId") ?? "");
    const followUpRaw = String(form.get("nextFollowUpAt") ?? "").trim();
    await db
      .update(prospect)
      .set({
        name,
        playaName: str("playaName", 100),
        email: str("email", 200)?.toLowerCase() ?? null,
        phone: str("phone", 50),
        ...(isProspectStatus(statusRaw) ? { status: statusRaw } : {}),
        ownerMembershipId: ownerRaw || null,
        nextFollowUpAt: followUpRaw ? new Date(followUpRaw) : null,
        ...touch,
      })
      .where(eq(prospect.id, prospectId));
    return data({ ok: "Saved." });
  }

  if (intent === "saveNotes") {
    await db
      .update(prospect)
      .set({ notes: str("notes", 20000), ...touch })
      .where(eq(prospect.id, prospectId));
    return data({ ok: "Notes saved." });
  }

  if (intent === "addHandle") {
    const value = str("value", 500);
    if (!value) return data({ error: "Enter the handle." }, { status: 400 });
    const kindRaw = String(form.get("kind") ?? "other");
    try {
      await db.insert(prospectHandle).values({
        id: crypto.randomUUID(),
        campId,
        prospectId,
        kind: isProspectChannel(kindRaw) ? kindRaw : "other",
        value,
        label: str("label", 120),
      });
    } catch {
      // The unique (prospect, kind, value) index — they already have this one.
      return data({ error: "That's already listed." }, { status: 409 });
    }
    await db.update(prospect).set(touch).where(eq(prospect.id, prospectId));
    return data({ ok: "Added." });
  }

  if (intent === "removeHandle") {
    await db
      .delete(prospectHandle)
      .where(
        and(
          eq(prospectHandle.id, String(form.get("handleId"))),
          eq(prospectHandle.prospectId, prospectId),
        ),
      );
    return data({ ok: "Removed." });
  }

  if (intent === "logInteraction") {
    const channelRaw = String(form.get("channel") ?? "other");
    const directionRaw = String(form.get("direction") ?? "note");
    const occurredRaw = String(form.get("occurredAt") ?? "").trim();
    const body = str("body", 20000);
    const subject = str("subject", 300);
    if (!body && !subject) {
      return data(
        { error: "Paste the message, or at least give it a subject." },
        { status: 400 },
      );
    }
    const sourceRaw = String(form.get("sourceUrl") ?? "").trim();
    const sourceUrl = sourceRaw ? normalizeUrl(sourceRaw) : null;
    if (sourceRaw && !sourceUrl) {
      return data(
        { error: "That link doesn't look like a URL." },
        {
          status: 400,
        },
      );
    }
    // An occurredAt in the future is almost always a typo'd year, and it would
    // pin the entry to the top of the log forever.
    const occurred = occurredRaw ? new Date(occurredRaw) : new Date();
    if (Number.isNaN(occurred.getTime())) {
      return data({ error: "That date doesn't parse." }, { status: 400 });
    }

    await db.insert(prospectInteraction).values({
      id: crypto.randomUUID(),
      campId,
      prospectId,
      authorMembershipId: myMid,
      channel: isProspectChannel(channelRaw) ? channelRaw : "other",
      direction: isDirection(directionRaw) ? directionRaw : "note",
      occurredAt: occurred,
      subject,
      body,
      sourceUrl,
      externalRef: str("externalRef", 500),
      counterparty: str("counterparty", 200),
    });
    // Logging a conversation means it IS a conversation now — advance a cold
    // lead automatically so nobody has to remember to. Guarded on `lead` so it
    // can never drag a further-along record backwards.
    await db
      .update(prospect)
      .set({ status: "talking", ...touch })
      .where(and(eq(prospect.id, prospectId), eq(prospect.status, "lead")));
    await db.update(prospect).set(touch).where(eq(prospect.id, prospectId));
    return data({ ok: "Logged." });
  }

  if (intent === "deleteInteraction") {
    await db
      .delete(prospectInteraction)
      .where(
        and(
          eq(prospectInteraction.id, String(form.get("interactionId"))),
          eq(prospectInteraction.prospectId, prospectId),
        ),
      );
    return data({ ok: "Deleted." });
  }

  if (intent === "createInvite") {
    // A personal, single-use link tied to this prospect: redeeming it stamps
    // the new membership onto this record so the history follows them in.
    const token = newInviteToken();
    await db.insert(campInvite).values({
      id: crypto.randomUUID(),
      campId,
      inviterMembershipId: myMid,
      token,
      kind: "personal",
      role: "recruit",
      maxUses: 1,
      note: `Prospect: ${row.name}`,
      prospectId,
    });
    await db
      .update(prospect)
      .set({ status: "invited", ...touch })
      .where(eq(prospect.id, prospectId));
    return data({ ok: "Invite link ready — copy it below." });
  }

  if (intent === "merge") {
    const survivorId = String(form.get("survivorId"));
    try {
      await mergeProspects(campId, survivorId, prospectId);
    } catch (e) {
      return data(
        { error: e instanceof Error ? e.message : "Merge failed." },
        { status: 400 },
      );
    }
    // This record is gone; the conversation continues on the survivor.
    throw redirect(`/prospects/${survivorId}`);
  }

  if (intent === "delete") {
    await db.delete(prospect).where(eq(prospect.id, prospectId));
    throw redirect("/prospects");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

export default function ProspectDetail({ loaderData }: Route.ComponentProps) {
  const { thread, officers, others, linkTargets, inviteBaseUrl } = loaderData;
  const p = thread.prospect;
  const sd = statusDef(p.status);

  const detailFetcher = useFetcher<FetcherData>();
  const notesFetcher = useFetcher<FetcherData>();
  const handleFetcher = useFetcher<FetcherData>();
  const logFetcher = useFetcher<FetcherData>();
  const inviteFetcher = useFetcher<FetcherData>();
  const mergeFetcher = useFetcher<FetcherData>();

  const [notes, setNotes] = useState(p.notes ?? "");
  const [logBody, setLogBody] = useState("");
  const logFormRef = useRef<HTMLFormElement>(null);
  const handleFormRef = useRef<HTMLFormElement>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useNotify(detailFetcher.data, detailFetcher.state);
  useNotify(notesFetcher.data, notesFetcher.state);
  useNotify(handleFetcher.data, handleFetcher.state, () =>
    handleFormRef.current?.reset(),
  );
  useNotify(logFetcher.data, logFetcher.state, () => {
    logFormRef.current?.reset();
    setLogBody("");
  });
  useNotify(inviteFetcher.data, inviteFetcher.state);
  useNotify(mergeFetcher.data, mergeFetcher.state);

  const inviteUrl = thread.inviteToken
    ? `${inviteBaseUrl}/i/${thread.inviteToken}`
    : null;

  return (
    <Container size="md">
      <Stack gap="lg">
        <Stack gap={4}>
          <Anchor component={Link} to="/prospects" size="sm">
            ← All prospects
          </Anchor>
          <Group gap="sm" wrap="wrap">
            <Title order={2}>{p.name}</Title>
            <Badge color={sd.color} variant="light" size="lg">
              {sd.label}
            </Badge>
            {p.membershipId ? (
              <Badge color="green" variant="outline">
                now a member
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" c="dimmed">
            {sd.hint}
          </Text>
        </Stack>

        {/* --- Who they are ------------------------------------------------ */}
        <Card withBorder padding="md" radius="md">
          <detailFetcher.Form method="post">
            <input type="hidden" name="intent" value="updateDetails" />
            <Stack gap="sm">
              <Group grow align="flex-start" wrap="wrap">
                <TextInput
                  name="name"
                  label="Name"
                  defaultValue={p.name}
                  required
                />
                <TextInput
                  name="playaName"
                  label="Playa name"
                  defaultValue={p.playaName ?? ""}
                />
              </Group>
              <Group grow align="flex-start" wrap="wrap">
                <TextInput
                  name="email"
                  type="email"
                  label="Email"
                  defaultValue={p.email ?? ""}
                />
                <TextInput
                  name="phone"
                  label="Phone"
                  defaultValue={p.phone ?? ""}
                />
              </Group>
              <Group grow align="flex-start" wrap="wrap">
                <Select
                  name="status"
                  label="Status"
                  data={STATUS_OPTIONS}
                  defaultValue={p.status}
                  allowDeselect={false}
                />
                <Select
                  name="ownerMembershipId"
                  label="Looked after by"
                  description="Who's shepherding this conversation"
                  data={officers}
                  defaultValue={p.ownerMembershipId ?? null}
                  placeholder="Nobody yet"
                  searchable
                  clearable
                />
                <DateInput
                  name="nextFollowUpAt"
                  label="Follow up on"
                  description="Shows in Needs a nudge once it's due"
                  valueFormat="YYYY-MM-DD"
                  defaultValue={
                    p.nextFollowUpAt ? new Date(p.nextFollowUpAt) : null
                  }
                  clearable
                />
              </Group>
              <Group justify="flex-end">
                <Button
                  type="submit"
                  loading={detailFetcher.state !== "idle"}
                  variant="light"
                >
                  Save details
                </Button>
              </Group>
            </Stack>
          </detailFetcher.Form>
        </Card>

        {/* --- Where to reach them ----------------------------------------- */}
        <Card withBorder padding="md" radius="md">
          <Text fw={600} mb="xs">
            Where to reach them
          </Text>
          {thread.handles.length === 0 ? (
            <Text size="sm" c="dimmed" mb="sm">
              No handles yet. Adding one is also how a future application from
              them gets matched to this thread instead of starting a new one.
            </Text>
          ) : (
            <Stack gap={6} mb="sm">
              {thread.handles.map((h) => {
                const url = normalizeUrl(h.value);
                const linkable = /^https?:\/\//i.test(h.value.trim());
                return (
                  <Group key={h.id} gap="xs" wrap="nowrap">
                    <Badge size="sm" variant="light" w={90}>
                      {channelLabel(h.kind)}
                    </Badge>
                    {linkable && url ? (
                      <Anchor
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        size="sm"
                      >
                        {displayUrl(h.value)}
                      </Anchor>
                    ) : (
                      <Text size="sm">{h.value}</Text>
                    )}
                    {h.label ? (
                      <Text size="xs" c="dimmed">
                        {h.label}
                      </Text>
                    ) : null}
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={`Remove ${channelLabel(h.kind)} handle`}
                      onClick={() =>
                        handleFetcher.submit(
                          { intent: "removeHandle", handleId: h.id },
                          { method: "post" },
                        )
                      }
                    >
                      ×
                    </ActionIcon>
                  </Group>
                );
              })}
            </Stack>
          )}
          <handleFetcher.Form method="post" ref={handleFormRef}>
            <input type="hidden" name="intent" value="addHandle" />
            <Group align="flex-end" wrap="wrap" gap="sm">
              <Select
                name="kind"
                label="Where"
                data={CHANNEL_OPTIONS}
                defaultValue="facebook"
                w={{ base: "100%", xs: 150 }}
                allowDeselect={false}
              />
              <TextInput
                name="value"
                label="Handle or profile link"
                placeholder="facebook.com/… or @them"
                w={{ base: "100%", xs: 260 }}
              />
              <TextInput
                name="label"
                label="Note"
                placeholder="optional"
                w={{ base: "100%", xs: 160 }}
              />
              <Button
                type="submit"
                variant="light"
                loading={handleFetcher.state !== "idle"}
              >
                Add
              </Button>
            </Group>
          </handleFetcher.Form>
        </Card>

        {/* --- Log a conversation ------------------------------------------ */}
        <Card withBorder padding="md" radius="md">
          <Text fw={600} mb={4}>
            Log a conversation
          </Text>
          <Text size="sm" c="dimmed" mb="sm">
            Paste what they said — a screenshot works too. Include the link back
            to the original so anyone can go read the thread in context.
          </Text>
          <logFetcher.Form method="post" ref={logFormRef}>
            <input type="hidden" name="intent" value="logInteraction" />
            <input type="hidden" name="body" value={logBody} />
            <Stack gap="sm">
              <Group grow align="flex-start" wrap="wrap">
                <Select
                  name="channel"
                  label="Where"
                  data={CHANNEL_OPTIONS}
                  defaultValue="facebook"
                  allowDeselect={false}
                />
                <Select
                  name="direction"
                  label="Which way"
                  data={DIRECTION_OPTIONS}
                  defaultValue="inbound"
                  allowDeselect={false}
                />
                <DateTimePicker
                  name="occurredAt"
                  label="When it happened"
                  description="Not when you're typing it up"
                  valueFormat="YYYY-MM-DD HH:mm"
                  defaultValue={new Date()}
                />
              </Group>
              <TextInput
                name="subject"
                label="Subject or gist"
                placeholder="Re: camping with you all in 2026"
              />
              <MarkupTextarea
                label="What was said"
                value={logBody}
                onChange={setLogBody}
                targets={linkTargets}
                minRows={4}
                placeholder="Paste the message here. Pictures can be pasted or dropped in."
              />
              <Group grow align="flex-start" wrap="wrap">
                <TextInput
                  name="sourceUrl"
                  label="Link to the original"
                  placeholder="facebook.com/groups/…/posts/…"
                />
                <TextInput
                  name="counterparty"
                  label="Who else was on it"
                  placeholder="optional"
                />
                <TextInput
                  name="externalRef"
                  label="Message ID"
                  description="For email, so it's findable in your mail client"
                  placeholder="optional"
                />
              </Group>
              <Group justify="flex-end">
                <Button type="submit" loading={logFetcher.state !== "idle"}>
                  Log it
                </Button>
              </Group>
            </Stack>
          </logFetcher.Form>
        </Card>

        {/* --- The conversation -------------------------------------------- */}
        <Stack gap="xs">
          <Text fw={600}>
            Conversation · {thread.log.length}{" "}
            {thread.log.length === 1 ? "entry" : "entries"}
          </Text>
          {thread.log.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing logged yet.
            </Text>
          ) : (
            thread.log.map((i) => (
              <Card key={i.id} withBorder padding="md" radius="md">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Group gap="xs" wrap="wrap">
                    <Badge size="sm" variant="light">
                      {channelLabel(i.channel)}
                    </Badge>
                    <Badge
                      size="sm"
                      variant="outline"
                      color={i.direction === "inbound" ? "blue" : "gray"}
                    >
                      {directionLead(i.direction)}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {i.occurredAt.slice(0, 16).replace("T", " ")} · logged by{" "}
                      {i.authorName}
                    </Text>
                  </Group>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    aria-label="Delete this log entry"
                    onClick={() =>
                      logFetcher.submit(
                        { intent: "deleteInteraction", interactionId: i.id },
                        { method: "post" },
                      )
                    }
                  >
                    ×
                  </ActionIcon>
                </Group>
                {i.subject ? (
                  <Text fw={500} size="sm" mt="xs">
                    {i.subject}
                  </Text>
                ) : null}
                {i.body ? (
                  <div style={{ marginTop: 8 }}>
                    <WikiBody
                      blocks={parseWikiBody(i.body)}
                      knownSlugs={[]}
                      wikiEnabled={false}
                    />
                  </div>
                ) : null}
                {i.sourceUrl || i.counterparty || i.externalRef ? (
                  <Group gap="md" mt="xs" wrap="wrap">
                    {i.sourceUrl ? (
                      <Anchor
                        href={i.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        size="xs"
                      >
                        original: {displayUrl(i.sourceUrl)}
                      </Anchor>
                    ) : null}
                    {i.counterparty ? (
                      <Text size="xs" c="dimmed">
                        with {i.counterparty}
                      </Text>
                    ) : null}
                    {i.externalRef ? (
                      <Text size="xs" c="dimmed">
                        ref {i.externalRef}
                      </Text>
                    ) : null}
                  </Group>
                ) : null}
              </Card>
            ))
          )}
        </Stack>

        {/* --- Officers' running notes -------------------------------------- */}
        <Card withBorder padding="md" radius="md">
          <notesFetcher.Form method="post">
            <input type="hidden" name="intent" value="saveNotes" />
            <input type="hidden" name="notes" value={notes} />
            <Stack gap="sm">
              <MarkupTextarea
                label="Notes on them"
                value={notes}
                onChange={setNotes}
                targets={linkTargets}
                minRows={3}
                placeholder="The standing summary — what they want to do, what they need, anything the next officer should know."
              />
              <Group justify="flex-end">
                <Button
                  type="submit"
                  variant="light"
                  loading={notesFetcher.state !== "idle"}
                >
                  Save notes
                </Button>
              </Group>
            </Stack>
          </notesFetcher.Form>
        </Card>

        <Divider />

        {/* --- Turning them into a member ----------------------------------- */}
        <Card withBorder padding="md" radius="md">
          <Text fw={600} mb={4}>
            Bring them in
          </Text>
          {p.membershipId ? (
            <Text size="sm" c="dimmed">
              They joined — this history is now attached to their membership.{" "}
              <Anchor component={Link} to="/members" size="sm">
                See them in Members
              </Anchor>
            </Text>
          ) : inviteUrl ? (
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                Send them this. When they use it, this whole conversation
                follows them into the camp.
              </Text>
              <Group wrap="nowrap">
                <TextInput
                  readOnly
                  value={inviteUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Invite link"
                  style={{ flex: 1 }}
                />
                <CopyButton value={inviteUrl}>
                  {({ copied, copy }) => (
                    <Button onClick={copy} color={copied ? "green" : undefined}>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          ) : (
            <Group justify="space-between" wrap="wrap">
              <Text size="sm" c="dimmed">
                Make them a personal invite link tied to this record.
              </Text>
              <Button
                variant="light"
                loading={inviteFetcher.state !== "idle"}
                onClick={() =>
                  inviteFetcher.submit(
                    { intent: "createInvite" },
                    { method: "post" },
                  )
                }
              >
                Create invite link
              </Button>
            </Group>
          )}
        </Card>

        {/* --- Housekeeping -------------------------------------------------- */}
        <Group justify="space-between" wrap="wrap">
          <Button
            variant="subtle"
            color="orange"
            onClick={() => setMergeOpen(true)}
            disabled={others.length === 0}
          >
            Same person as another prospect
          </Button>
          <Button
            variant="subtle"
            color="red"
            onClick={() => setDeleteOpen(true)}
          >
            Delete this record
          </Button>
        </Group>

        <Modal
          opened={mergeOpen}
          onClose={() => setMergeOpen(false)}
          title={`Merge ${p.name} into another prospect`}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              Use this when several of us started separate threads with the same
              person. Every message and handle on <strong>{p.name}</strong>{" "}
              moves onto the record you pick, the whole history sorts back
              together, and this duplicate goes away.
            </Text>
            <Select
              label="Keep this record"
              placeholder="Pick the one to keep"
              searchable
              data={others}
              value={mergeInto}
              onChange={setMergeInto}
            />
            <Text size="xs" c="dimmed">
              Contact details fill in only where the surviving record is blank,
              and the further-along status wins. This can't be undone.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setMergeOpen(false)}>
                Cancel
              </Button>
              <Button
                color="orange"
                disabled={!mergeInto}
                loading={mergeFetcher.state !== "idle"}
                onClick={() => {
                  if (mergeInto)
                    mergeFetcher.submit(
                      { intent: "merge", survivorId: mergeInto },
                      { method: "post" },
                    );
                }}
              >
                Merge
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title={`Delete ${p.name}?`}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              This throws away the whole conversation — every logged message and
              every handle. If this is the same human as another record, merge
              instead so nothing is lost.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <mergeFetcher.Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <Button type="submit" color="red">
                  Delete
                </Button>
              </mergeFetcher.Form>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Container>
  );
}

function useNotify(
  d: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !d || d === seen.current) return;
    seen.current = d;
    if (d.error) {
      notifications.show({ color: "red", title: "Error", message: d.error });
    } else if (d.ok) {
      notifications.show({ title: "Done", message: d.ok });
      onOk?.();
    }
  }, [d, state, onOk]);
}
