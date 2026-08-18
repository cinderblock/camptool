/**
 * Prospects — the officer CRM list. See plans/prospects-crm.md.
 *
 * Officer-only in the loader AND the action, not merely hidden from the nav:
 * this holds candid notes about people who have consented to nothing.
 */
import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  CHANNEL_OPTIONS,
  STATUS_OPTIONS,
  channelLabel,
  followUpDue,
  isProspectChannel,
  isProspectStatus,
  statusDef,
} from "~/lib/prospects";
import { loadProspects, unlinkedApplications } from "~/lib/prospects.server";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { prospect, prospectHandle } from "../../../db/schema";
import type { Route } from "./+types/prospects";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Prospects · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "prospects");
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const campId = active.camp.id;

  const [rows, pendingApps] = await Promise.all([
    loadProspects(campId),
    unlinkedApplications(campId),
  ]);

  return redact(privacy, {
    myMembershipId: active.membership.id,
    prospects: rows,
    // Offered as a one-click backfill: a camp that turns this on with a queue
    // already sitting in /recruits shouldn't have to retype it.
    unlinkedApplicationCount: pendingApps.length,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  await requireFeature(active, "prospects");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers only." }, { status: 403 });
  }
  const campId = active.camp.id;
  const myMid = active.membership.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "addProspect") {
    const name = String(form.get("name") ?? "")
      .trim()
      .slice(0, 200);
    if (!name) {
      return data(
        { error: "A name is required — even a partial one." },
        {
          status: 400,
        },
      );
    }
    const statusRaw = String(form.get("status") ?? "lead");
    const status = isProspectStatus(statusRaw) ? statusRaw : "lead";
    const email =
      String(form.get("email") ?? "")
        .trim()
        .toLowerCase() || null;
    const handleKindRaw = String(form.get("handleKind") ?? "other");
    const handleValue = String(form.get("handleValue") ?? "").trim();

    const id = crypto.randomUUID();
    await db.insert(prospect).values({
      id,
      campId,
      name,
      email,
      status,
      // Whoever adds them is shepherding them until someone says otherwise —
      // an unowned prospect is how people get dropped.
      ownerMembershipId: myMid,
      createdByMembershipId: myMid,
    });
    if (handleValue) {
      await db.insert(prospectHandle).values({
        id: crypto.randomUUID(),
        campId,
        prospectId: id,
        kind: isProspectChannel(handleKindRaw) ? handleKindRaw : "other",
        value: handleValue.slice(0, 500),
      });
    }
    return data({ ok: `Added ${name}.`, createdId: id });
  }

  if (intent === "importApplications") {
    const apps = await unlinkedApplications(campId);
    for (const a of apps) {
      const id = crypto.randomUUID();
      await db.insert(prospect).values({
        id,
        campId,
        name: a.name,
        playaName: a.playaName,
        email: a.email,
        // An already-reviewed application isn't still "applied": accepted
        // people joined, rejected ones are a no. Only pending ones are live.
        status:
          a.status === "accepted"
            ? "joined"
            : a.status === "rejected"
              ? "passed"
              : "applied",
        recruitApplicationId: a.id,
        createdByMembershipId: myMid,
        createdAt: a.createdAt,
      });
    }
    return data({
      ok: `Brought ${apps.length} application${apps.length === 1 ? "" : "s"} in.`,
    });
  }

  if (intent === "claim") {
    const id = String(form.get("prospectId"));
    await db
      .update(prospect)
      .set({ ownerMembershipId: myMid, updatedAt: new Date() })
      .where(and(eq(prospect.id, id), eq(prospect.campId, campId)));
    return data({ ok: "You're looking after them now." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string; createdId?: string };

export default function Prospects({ loaderData }: Route.ComponentProps) {
  const { prospects, myMembershipId, unlinkedApplicationCount } = loaderData;
  const addFetcher = useFetcher<FetcherData>();
  const importFetcher = useFetcher<FetcherData>();
  const claimFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);

  const [scope, setScope] = useState<"open" | "mine" | "attention" | "all">(
    "open",
  );
  const [query, setQuery] = useState("");

  useNotify(addFetcher.data, addFetcher.state, () =>
    addFormRef.current?.reset(),
  );
  useNotify(importFetcher.data, importFetcher.state);
  useNotify(claimFetcher.data, claimFetcher.state);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const matches = (p: (typeof prospects)[number]) => {
      if (needle) {
        const hay = `${p.name} ${p.playaName ?? ""} ${p.email ?? ""} ${p.handles
          .map((h) => h.value)
          .join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (scope === "all") return true;
      if (scope === "mine") return p.ownerMembershipId === myMembershipId;
      if (scope === "attention") {
        return (
          !statusDef(p.status).closed &&
          (!p.ownerMembershipId || followUpDue(p.nextFollowUpAt))
        );
      }
      return !statusDef(p.status).closed;
    };
    return prospects.filter(matches);
  }, [prospects, needle, scope, myMembershipId]);

  const attention = prospects.filter(
    (p) =>
      !statusDef(p.status).closed &&
      (!p.ownerMembershipId || followUpDue(p.nextFollowUpAt)),
  ).length;

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Stack gap={2}>
          <Title order={2}>Prospects</Title>
          <Text size="sm" c="dimmed">
            Everyone the camp is talking to who hasn't joined yet — and what
            each of us has said to them. Officers only; members never see this.
          </Text>
        </Stack>

        <Card withBorder padding="md" radius="md">
          <addFetcher.Form method="post" ref={addFormRef}>
            <input type="hidden" name="intent" value="addProspect" />
            <Group align="flex-end" wrap="wrap" gap="sm">
              <TextInput
                name="name"
                label="Who are they?"
                description="Whatever you've got — a partial name is fine"
                placeholder="Jenny from the art thread"
                w={{ base: "100%", sm: 240 }}
                required
              />
              <TextInput
                name="email"
                type="email"
                label="Email"
                placeholder="optional"
                w={{ base: "100%", sm: 200 }}
              />
              <Select
                name="handleKind"
                label="Found them on"
                data={CHANNEL_OPTIONS}
                defaultValue="facebook"
                w={{ base: "100%", sm: 150 }}
                allowDeselect={false}
              />
              <TextInput
                name="handleValue"
                label="Their handle or profile"
                placeholder="optional"
                w={{ base: "100%", sm: 220 }}
              />
              <Select
                name="status"
                label="Status"
                data={STATUS_OPTIONS}
                defaultValue="talking"
                w={{ base: "100%", sm: 140 }}
                allowDeselect={false}
              />
              <Button type="submit" loading={addFetcher.state !== "idle"}>
                Add
              </Button>
            </Group>
          </addFetcher.Form>
        </Card>

        {unlinkedApplicationCount > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" wrap="wrap">
              <Text size="sm">
                {unlinkedApplicationCount} application
                {unlinkedApplicationCount === 1 ? "" : "s"} in the recruits
                queue {unlinkedApplicationCount === 1 ? "isn't" : "aren't"} here
                yet. New applications land here automatically — this is for the
                ones that arrived before you turned this on.
              </Text>
              <Button
                variant="light"
                loading={importFetcher.state !== "idle"}
                onClick={() =>
                  importFetcher.submit(
                    { intent: "importApplications" },
                    { method: "post" },
                  )
                }
              >
                Bring them in
              </Button>
            </Group>
          </Card>
        ) : null}

        <Group align="flex-end" wrap="wrap">
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v as typeof scope)}
            data={[
              { value: "open", label: "Open" },
              { value: "mine", label: "Mine" },
              {
                value: "attention",
                label:
                  attention > 0
                    ? `Needs a nudge · ${attention}`
                    : "Needs a nudge",
              },
              { value: "all", label: "All" },
            ]}
          />
          <TextInput
            label="Search"
            placeholder="Name, email, or handle"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            w={{ base: "100%", xs: 260 }}
          />
        </Group>

        {shown.length === 0 ? (
          <Text c="dimmed">
            {prospects.length === 0
              ? "Nobody here yet. Add the first person you're talking to above."
              : "Nobody matches that."}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={860}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Who</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Looked after by</Table.Th>
                  <Table.Th>Reachable at</Table.Th>
                  <Table.Th>Last contact</Table.Th>
                  <Table.Th>Follow up</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((p) => {
                  const sd = statusDef(p.status);
                  const due = followUpDue(p.nextFollowUpAt);
                  return (
                    <Table.Tr key={p.id}>
                      <Table.Td>
                        <Anchor
                          component={Link}
                          to={`/prospects/${p.id}`}
                          fw={500}
                        >
                          {p.name}
                        </Anchor>
                        {p.playaName ? (
                          <Text size="xs" c="dimmed">
                            “{p.playaName}”
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td>
                        <Badge color={sd.color} variant="light">
                          {sd.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {p.ownerName ? (
                          <Text size="sm">{p.ownerName}</Text>
                        ) : (
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() =>
                              claimFetcher.submit(
                                { intent: "claim", prospectId: p.id },
                                { method: "post" },
                              )
                            }
                          >
                            Unclaimed — take it
                          </Button>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {p.email || p.handles.length ? (
                          <Text size="xs" c="dimmed">
                            {[
                              p.email,
                              ...p.handles.map(
                                (h) => `${channelLabel(h.kind)}: ${h.value}`,
                              ),
                            ]
                              .filter(Boolean)
                              .slice(0, 2)
                              .join(" · ")}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {p.lastInteractionAt
                            ? `${p.lastInteractionAt.slice(0, 10)} · ${p.interactionCount}`
                            : "never"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {p.nextFollowUpAt ? (
                          <Text
                            size="xs"
                            c={due ? "orange" : "dimmed"}
                            fw={due ? 600 : 400}
                          >
                            {p.nextFollowUpAt.slice(0, 10)}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
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
