/**
 * Camp settings — ADMIN-only management of the camp's opt-in features
 * (plans/camp-features.md). One card per registry entry with an
 * Off / Preview / On control. Preview = officers+ can use the feature while
 * the rest of the camp doesn't see it. Turning a feature off never deletes
 * its data.
 */
import {
  Badge,
  Card,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { data, redirect, useFetcher } from "react-router";
import {
  FEATURES,
  type FeatureKey,
  type FeatureState,
  featureDef,
  isFeatureState,
} from "~/lib/features";
import { loadFeatureStates, setFeatureState } from "~/lib/features.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/settings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp settings · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  if (active.membership.role !== "admin") throw redirect("/");
  const states = await loadFeatureStates(active.camp.id);
  return {
    campName: active.camp.name,
    features: FEATURES.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      requires: def.requires ?? [],
      state: states.get(def.key) ?? "off",
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  if (active.membership.role !== "admin") {
    return data({ error: "Only the camp admin can change features." }, 403);
  }
  const form = await request.formData();
  const key = String(form.get("feature") ?? "");
  const state = String(form.get("state") ?? "");
  const def = featureDef(key as FeatureKey);
  if (!def || !isFeatureState(state)) {
    return data({ error: "Unknown feature or state." }, 400);
  }
  await setFeatureState({
    campId: active.camp.id,
    key: def.key,
    state,
    updatedByMembershipId: active.membership.id,
  });
  return { ok: true };
}

const STATE_OPTIONS: { label: string; value: FeatureState }[] = [
  { label: "Off", value: "off" },
  { label: "Preview", value: "preview" },
  { label: "On", value: "on" },
];

function FeatureCard({
  feature,
  stateOf,
}: {
  feature: {
    key: FeatureKey;
    label: string;
    description: string;
    requires: FeatureKey[];
    state: FeatureState;
  };
  stateOf: (key: FeatureKey) => FeatureState;
}) {
  const fetcher = useFetcher();
  // Optimistic: show the submitted state while the save is in flight.
  const state =
    fetcher.formData?.get("feature") === feature.key
      ? ((fetcher.formData.get("state") as FeatureState) ?? feature.state)
      : feature.state;
  const unmet = feature.requires.filter((dep) => stateOf(dep) === "off");
  return (
    <Card withBorder padding="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={600}>{feature.label}</Text>
            {state === "preview" ? (
              <Badge size="xs" color="grape" variant="light">
                preview
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" c="dimmed">
            {feature.description}
          </Text>
          {state !== "off" && unmet.length > 0 ? (
            <Text size="xs" c="orange">
              Works best with{" "}
              {unmet.map((dep) => featureDef(dep)?.label ?? dep).join(" and ")}{" "}
              turned on too.
            </Text>
          ) : null}
        </div>
        <SegmentedControl
          size="xs"
          value={state}
          onChange={(value) =>
            fetcher.submit(
              { feature: feature.key, state: value },
              { method: "post" },
            )
          }
          data={STATE_OPTIONS}
        />
      </Group>
    </Card>
  );
}

export default function CampSettings({ loaderData }: Route.ComponentProps) {
  const { campName, features } = loaderData;
  const stateOf = (key: FeatureKey): FeatureState =>
    features.find((f) => f.key === key)?.state ?? "off";
  return (
    <Container size="sm">
      <Stack gap="md">
        <div>
          <Title order={2}>Camp settings</Title>
          <Text c="dimmed" size="sm">
            Choose which features {campName} uses. <b>Preview</b> lets officers
            explore a feature before the whole camp sees it; turning a feature
            off hides it but never deletes its data.
          </Text>
        </div>
        {features.map((f) => (
          <FeatureCard key={f.key} feature={f} stateOf={stateOf} />
        ))}
      </Stack>
    </Container>
  );
}
