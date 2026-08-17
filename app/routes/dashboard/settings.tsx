/**
 * Camp settings — ADMIN-only management of the camp's opt-in features
 * (plans/camp-features.md). One card per registry entry with an
 * Off / Preview / On control. Preview = officers+ can use the feature while
 * the rest of the camp doesn't see it. Turning a feature off never deletes
 * its data.
 */
import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { data, redirect, useFetcher } from "react-router";
import {
  clearBinsLink,
  getBinsLink,
  normalizeBinsUrl,
  setBinsLink,
} from "~/lib/bins.server";
import {
  FEATURES,
  type FeatureKey,
  type FeatureState,
  featureDef,
  isFeatureState,
} from "~/lib/features";
import { loadFeatureStates, setFeatureState } from "~/lib/features.server";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/settings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp settings · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  if (active.membership.role !== "admin") throw redirect("/");
  const states = await loadFeatureStates(active.camp.id);
  const binsLink = await getBinsLink(active.camp.id);
  return redact(privacy, {
    campName: active.camp.name,
    // The access code itself never leaves the server — only whether one is set,
    // so the admin can tell a configured link from an unconfigured one.
    bins: {
      baseUrl: binsLink?.baseUrl ?? "",
      label: binsLink?.label ?? "",
      hasCode: !!binsLink?.accessCode,
    },
    features: FEATURES.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      requires: def.requires ?? [],
      state: states.get(def.key) ?? "off",
    })),
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  if (active.membership.role !== "admin") {
    return data({ error: "Only the camp admin can change features." }, 403);
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "bins") {
    const baseUrl = normalizeBinsUrl(String(form.get("baseUrl") ?? ""));
    if (!baseUrl) {
      return data({ error: "Enter the web address of your bins site." }, 400);
    }
    // A blank code field means "leave the stored one alone" — the form can't
    // show the existing secret, so blank must not silently erase it.
    const typed = String(form.get("accessCode") ?? "").trim();
    const existing = await getBinsLink(active.camp.id);
    await setBinsLink({
      campId: active.camp.id,
      baseUrl,
      accessCode: typed || existing?.accessCode || null,
      label: String(form.get("label") ?? "").trim() || null,
      updatedByMembershipId: active.membership.id,
    });
    return { ok: true };
  }

  if (intent === "binsClear") {
    await clearBinsLink(active.camp.id);
    return { ok: true };
  }

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

/** Where the camp's bins instance lives — shown under the Bins feature card
 * once it's switched on, since the shortcut is useless without an address. */
function BinsConfig({
  bins,
}: {
  bins: { baseUrl: string; label: string; hasCode: boolean };
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [baseUrl, setBaseUrl] = useState(bins.baseUrl);
  const [label, setLabel] = useState(bins.label);
  const [accessCode, setAccessCode] = useState("");
  const saving = fetcher.state !== "idle";

  return (
    <Card withBorder padding="md" ml="md">
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          Where your bins site lives
        </Text>
        <TextInput
          size="xs"
          label="Address"
          placeholder="https://i.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Access code"
          placeholder={
            bins.hasCode ? "Saved — type a new one to replace it" : "Optional"
          }
          value={accessCode}
          onChange={(e) => setAccessCode(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">
          The code from your bins site's Settings page — the one its invite link
          carries. With it, the menu item signs people straight in. It's stored
          for the camp and handed out only when a member clicks, never printed
          on the page. Members and up get the shortcut; recruits don't.
        </Text>
        <TextInput
          size="xs"
          label="Menu label"
          placeholder="Bins"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        {fetcher.data?.error ? (
          <Text size="xs" c="red">
            {fetcher.data.error}
          </Text>
        ) : null}
        <Group justify="space-between">
          {bins.baseUrl ? (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              loading={saving}
              onClick={() =>
                fetcher.submit({ intent: "binsClear" }, { method: "post" })
              }
            >
              Remove
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="xs"
            loading={saving}
            onClick={() =>
              fetcher.submit(
                { intent: "bins", baseUrl, accessCode, label },
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

export default function CampSettings({ loaderData }: Route.ComponentProps) {
  const { campName, features, bins } = loaderData;
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
          <div key={f.key}>
            <FeatureCard feature={f} stateOf={stateOf} />
            {f.key === "bins" && f.state !== "off" ? (
              <BinsConfig bins={bins} />
            ) : null}
          </div>
        ))}
      </Stack>
    </Container>
  );
}
