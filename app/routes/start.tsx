import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { useState } from "react";
import { data, redirect, useFetcher, useNavigate } from "react-router";
import { requireActiveEdition } from "~/lib/session.server";
import { KINDS, ShapeSwatch, hasTag, kindDef } from "~/lib/structures";
import { db } from "../../db/client.server";
import {
  mapObject,
  mapObjectOccupant,
  membership,
  onboardingCompletion,
  onboardingTask,
  user,
} from "../../db/schema";
import type { Route } from "./+types/start";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Get started · CampTool" }];
}

// Wizard step indices (also the value persisted in membership.wizardStep).
const STEP_COUNT = 5;

export async function loader({ request }: Route.LoaderArgs) {
  const {
    user: authUser,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;

  const [me] = await db
    .select({
      playaName: membership.playaName,
      wizardStep: membership.wizardStep,
      wizardCompletedAt: membership.wizardCompletedAt,
    })
    .from(membership)
    .where(eq(membership.id, mid))
    .limit(1);

  const items = await db
    .select({
      id: mapObject.id,
      kind: mapObject.kind,
      name: mapObject.name,
      width: mapObject.width,
      height: mapObject.height,
      placed: mapObject.placed,
    })
    .from(mapObject)
    .where(
      and(
        eq(mapObject.editionId, editionId),
        eq(mapObject.ownerMembershipId, mid),
      ),
    );

  const occupants = await db
    .select({
      objectId: mapObjectOccupant.objectId,
      membershipId: mapObjectOccupant.membershipId,
      name: user.name,
    })
    .from(mapObjectOccupant)
    .innerJoin(mapObject, eq(mapObjectOccupant.objectId, mapObject.id))
    .leftJoin(membership, eq(mapObjectOccupant.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(mapObject.ownerMembershipId, mid),
        eq(mapObjectOccupant.editionId, editionId),
      ),
    );

  const rosterRows = await db
    .select({ membershipId: membership.id, name: user.name })
    .from(membership)
    .leftJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(membership.organizationId, campId),
        eq(membership.status, "active"),
      ),
    );

  const tasks = await db
    .select()
    .from(onboardingTask)
    .where(eq(onboardingTask.campId, campId))
    .orderBy(asc(onboardingTask.sortOrder), asc(onboardingTask.createdAt));
  const doneRows = await db
    .select({ taskId: onboardingCompletion.taskId })
    .from(onboardingCompletion)
    .where(eq(onboardingCompletion.membershipId, mid));
  const doneSet = new Set(doneRows.map((d) => d.taskId));

  return {
    locked: activeEdition.locked,
    userName: authUser.name,
    playaName: me?.playaName ?? null,
    wizardStep: me?.wizardStep ?? 0,
    completed: Boolean(me?.wizardCompletedAt),
    items,
    occupants,
    roster: rosterRows.filter((r) => r.membershipId !== mid),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      done: doneSet.has(t.id),
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "saveProfile") {
    const v = form.get("playaName");
    const playaName = v == null || v === "" ? null : String(v);
    await db
      .update(membership)
      .set({ playaName })
      .where(eq(membership.id, mid));
    return data({ ok: true });
  }

  if (intent === "setStep") {
    const step = Math.max(
      0,
      Math.min(STEP_COUNT - 1, Number(form.get("step"))),
    );
    // Persist the *furthest* step reached so a brand-new member is only
    // auto-redirected here once (any forward move / skip bumps it off 0).
    await db
      .update(membership)
      .set({ wizardStep: sql`max(${membership.wizardStep}, ${step})` })
      .where(eq(membership.id, mid));
    return data({ ok: true });
  }

  if (intent === "complete") {
    await db
      .update(membership)
      .set({
        wizardCompletedAt: new Date(),
        wizardStep: sql`max(${membership.wizardStep}, ${STEP_COUNT - 1})`,
      })
      .where(eq(membership.id, mid));
    return redirect("/dashboard");
  }

  // Occupant edits touch edition-scoped data, so they respect the lock.
  if (intent === "addOccupant" || intent === "removeOccupant") {
    if (activeEdition.locked) {
      return data({ error: "This year is locked." }, { status: 403 });
    }
    const objectId = String(form.get("objectId"));
    const membershipId = String(form.get("membershipId"));
    // Confirm the structure is the caller's own item in this edition.
    const [own] = await db
      .select({ id: mapObject.id })
      .from(mapObject)
      .where(
        and(
          eq(mapObject.id, objectId),
          eq(mapObject.editionId, editionId),
          eq(mapObject.ownerMembershipId, mid),
        ),
      )
      .limit(1);
    if (!own) return data({ error: "Not your item." }, { status: 403 });

    if (intent === "addOccupant") {
      const [existing] = await db
        .select({ id: mapObjectOccupant.id })
        .from(mapObjectOccupant)
        .where(
          and(
            eq(mapObjectOccupant.objectId, objectId),
            eq(mapObjectOccupant.membershipId, membershipId),
          ),
        )
        .limit(1);
      if (!existing) {
        await db.insert(mapObjectOccupant).values({
          id: crypto.randomUUID(),
          campId,
          editionId,
          objectId,
          membershipId,
        });
      }
      return data({ ok: true });
    }
    await db
      .delete(mapObjectOccupant)
      .where(
        and(
          eq(mapObjectOccupant.objectId, objectId),
          eq(mapObjectOccupant.membershipId, membershipId),
        ),
      );
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type LoaderData = Route.ComponentProps["loaderData"];

export default function StartWizard({ loaderData }: Route.ComponentProps) {
  const { wizardStep, locked } = loaderData;
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [active, setActive] = useState(
    Math.min(Math.max(0, wizardStep), STEP_COUNT - 1),
  );

  function goto(step: number) {
    const next = Math.max(0, Math.min(STEP_COUNT - 1, step));
    setActive(next);
    fetcher.submit(
      { intent: "setStep", step: String(next) },
      { method: "post" },
    );
  }
  function skip() {
    // Mark as started so the dashboard won't auto-redirect here again.
    fetcher.submit({ intent: "setStep", step: "1" }, { method: "post" });
    navigate("/dashboard");
  }
  function finish() {
    fetcher.submit({ intent: "complete" }, { method: "post" });
  }

  return (
    <Container size="sm" py="xl">
      <Group justify="space-between" align="flex-end" mb="lg">
        <div>
          <Title order={2}>Welcome — let's get you set up</Title>
          <Text c="dimmed" size="sm">
            A few quick steps. You can stop anytime and pick up where you left
            off, or do it all manually in the dashboard.
          </Text>
        </div>
        <Button variant="subtle" size="xs" onClick={skip}>
          Skip / do it manually
        </Button>
      </Group>

      {locked ? (
        <Paper
          withBorder
          p="md"
          radius="md"
          mb="md"
          bg="var(--mantine-color-gray-0)"
        >
          <Text size="sm" c="dimmed">
            This year is locked — items and occupants are read-only.
          </Text>
        </Paper>
      ) : null}

      <Stepper active={active} onStepClick={goto} size="sm">
        <Stepper.Step label="Profile" description="Your name">
          <ProfileStep data={loaderData} fetcher={fetcher} />
        </Stepper.Step>
        <Stepper.Step label="Bringing" description="Your stuff">
          <BringingStep data={loaderData} />
        </Stepper.Step>
        <Stepper.Step label="Sharing" description="Who's with you">
          <OccupantsStep data={loaderData} />
        </Stepper.Step>
        <Stepper.Step label="Checklist" description="Camp tasks">
          <ChecklistStep data={loaderData} />
        </Stepper.Step>
        <Stepper.Completed>
          <Paper withBorder p="lg" radius="md" mt="md">
            <Title order={4} mb="xs">
              You're all set!
            </Title>
            <Text size="sm" c="dimmed">
              Thanks for setting up. You can refine any of this anytime from the
              dashboard — Bringing, the map, and the onboarding checklist.
            </Text>
          </Paper>
        </Stepper.Completed>
      </Stepper>

      <Group justify="space-between" mt="xl">
        <Button
          variant="default"
          onClick={() => goto(active - 1)}
          disabled={active === 0}
        >
          Back
        </Button>
        {active < STEP_COUNT - 1 ? (
          <Button onClick={() => goto(active + 1)}>Next</Button>
        ) : (
          <Button color="green" onClick={finish}>
            Finish
          </Button>
        )}
      </Group>
    </Container>
  );
}

function ProfileStep({
  data: d,
  fetcher,
}: {
  data: LoaderData;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <Stack gap="sm" mt="md" maw={420}>
      <Text size="sm">
        Signed in as <b>{d.userName}</b>.
      </Text>
      <TextInput
        label="Playa name (optional)"
        description="What folks call you out on the playa."
        placeholder="e.g. Sparkle"
        defaultValue={d.playaName ?? ""}
        onBlur={(e) =>
          fetcher.submit(
            { intent: "saveProfile", playaName: e.currentTarget.value },
            { method: "post" },
          )
        }
      />
    </Stack>
  );
}

function BringingStep({ data: d }: { data: LoaderData }) {
  // Reuse the Bringing page's action so there's one source of truth for items.
  const itemFetcher = useFetcher();
  const add = (kind: string) =>
    itemFetcher.submit(
      { intent: "addItem", kind },
      { method: "post", action: "/dashboard/bringing" },
    );
  const update = (id: string, fields: Record<string, string>) =>
    itemFetcher.submit(
      { intent: "updateItem", id, ...fields },
      { method: "post", action: "/dashboard/bringing" },
    );
  const remove = (id: string) =>
    itemFetcher.submit(
      { intent: "removeItem", id },
      { method: "post", action: "/dashboard/bringing" },
    );

  return (
    <Stack gap="md" mt="md">
      <Text size="sm" c="dimmed">
        What are you bringing? Add each structure or vehicle and give its size.
      </Text>
      {!d.locked ? (
        <Group gap="xs">
          {KINDS.map((k) => (
            <Button
              key={k.value}
              size="xs"
              variant="default"
              leftSection={<ShapeSwatch kind={k} size={14} />}
              onClick={() => add(k.value)}
            >
              {k.label}
            </Button>
          ))}
        </Group>
      ) : null}
      {d.items.length === 0 ? (
        <Text c="dimmed" size="sm">
          Nothing yet — add what you're bringing above.
        </Text>
      ) : (
        <Stack gap="sm">
          {d.items.map((item) => {
            const def = kindDef(item.kind);
            return (
              <Paper key={item.id} withBorder p="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" align="flex-end">
                  <Group gap="sm" wrap="nowrap" align="center">
                    <ShapeSwatch kind={def} size={20} />
                    <Text fw={600} size="sm">
                      {def.label}
                    </Text>
                  </Group>
                  <Group gap="sm" wrap="nowrap" align="flex-end">
                    <TextInput
                      size="xs"
                      label="Name"
                      w={120}
                      placeholder="optional"
                      disabled={d.locked}
                      defaultValue={item.name ?? ""}
                      onBlur={(e) =>
                        update(item.id, { name: e.currentTarget.value })
                      }
                    />
                    {def.rigid ? null : (
                      <NumberInput
                        size="xs"
                        label={def.vehicle ? "Length (ft)" : "Depth (ft)"}
                        w={96}
                        min={def.vehicle ? 6 : 1}
                        disabled={d.locked}
                        defaultValue={Math.round(item.height)}
                        onBlur={(e) =>
                          update(item.id, {
                            height: String(
                              Math.max(1, Number(e.currentTarget.value) || 1),
                            ),
                          })
                        }
                      />
                    )}
                    {!def.rigid && !def.vehicle ? (
                      <NumberInput
                        size="xs"
                        label="Width (ft)"
                        w={96}
                        min={1}
                        disabled={d.locked}
                        defaultValue={Math.round(item.width)}
                        onBlur={(e) =>
                          update(item.id, {
                            width: String(
                              Math.max(1, Number(e.currentTarget.value) || 1),
                            ),
                          })
                        }
                      />
                    ) : null}
                    {d.locked ? null : (
                      <Tooltip label="Remove">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          mb={4}
                          onClick={() => remove(item.id)}
                        >
                          ✕
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

function OccupantsStep({ data: d }: { data: LoaderData }) {
  const fetcher = useFetcher();
  // Only structures that hold people (domiciles + vehicles) take occupants.
  const holders = d.items.filter(
    (i) => hasTag(i.kind, "domicile") || hasTag(i.kind, "vehicle"),
  );
  const rosterOptions = d.roster.map((r) => ({
    value: r.membershipId,
    label: r.name ?? "Member",
  }));

  return (
    <Stack gap="md" mt="md">
      <Text size="sm" c="dimmed">
        Sharing a tent, RV, or vehicle? Add the other campers staying in it.
      </Text>
      {holders.length === 0 ? (
        <Text c="dimmed" size="sm">
          Add a tent/RV/vehicle in the previous step to assign occupants.
        </Text>
      ) : (
        holders.map((item) => {
          const def = kindDef(item.kind);
          const occ = d.occupants.filter((o) => o.objectId === item.id);
          const occIds = new Set(occ.map((o) => o.membershipId));
          const avail = rosterOptions.filter((r) => !occIds.has(r.value));
          return (
            <Paper key={item.id} withBorder p="sm" radius="md">
              <Group gap="sm" mb={6}>
                <ShapeSwatch kind={def} size={18} />
                <Text fw={600} size="sm">
                  {item.name ?? def.label}
                </Text>
              </Group>
              <Group gap={6} mb="xs">
                {occ.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    Just you so far.
                  </Text>
                ) : (
                  occ.map((o) => (
                    <Badge
                      key={o.membershipId}
                      variant="light"
                      rightSection={
                        d.locked ? null : (
                          <ActionIcon
                            size="xs"
                            variant="transparent"
                            color="gray"
                            onClick={() =>
                              fetcher.submit(
                                {
                                  intent: "removeOccupant",
                                  objectId: item.id,
                                  membershipId: o.membershipId,
                                },
                                { method: "post" },
                              )
                            }
                          >
                            ✕
                          </ActionIcon>
                        )
                      }
                    >
                      {o.name ?? "Member"}
                    </Badge>
                  ))
                )}
              </Group>
              {!d.locked && avail.length > 0 ? (
                <Select
                  size="xs"
                  placeholder="Add a camper…"
                  searchable
                  data={avail}
                  value={null}
                  onChange={(v) =>
                    v &&
                    fetcher.submit(
                      {
                        intent: "addOccupant",
                        objectId: item.id,
                        membershipId: v,
                      },
                      { method: "post" },
                    )
                  }
                  comboboxProps={{ withinPortal: true }}
                />
              ) : null}
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

function ChecklistStep({ data: d }: { data: LoaderData }) {
  // Reuse the onboarding page's toggle action.
  const fetcher = useFetcher();
  return (
    <Stack gap="sm" mt="md">
      <Text size="sm" c="dimmed">
        A few things the camp asks everyone to take care of.
      </Text>
      {d.tasks.length === 0 ? (
        <Text c="dimmed" size="sm">
          No checklist items yet — you're good.
        </Text>
      ) : (
        d.tasks.map((t) => (
          <Checkbox
            key={t.id}
            label={t.title}
            checked={t.done}
            onChange={() =>
              fetcher.submit(
                { intent: "toggle", taskId: t.id },
                { method: "post", action: "/dashboard/onboarding" },
              )
            }
          />
        ))
      )}
    </Stack>
  );
}
