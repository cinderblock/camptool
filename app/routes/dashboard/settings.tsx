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
  Collapse,
  Container,
  Divider,
  Group,
  PasswordInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { type ReactNode, useState } from "react";
import { data, redirect, useFetcher } from "react-router";
import { clearBinsCache } from "~/lib/bins-api.server";
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
      hasToken: !!binsLink?.apiToken,
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
    const typedToken = String(form.get("apiToken") ?? "").trim();
    const existing = await getBinsLink(active.camp.id);
    await setBinsLink({
      campId: active.camp.id,
      baseUrl,
      accessCode: typed || existing?.accessCode || null,
      apiToken: typedToken || existing?.apiToken || null,
      label: String(form.get("label") ?? "").trim() || null,
      updatedByMembershipId: active.membership.id,
    });
    // Config changed — the next Supplies view should re-read, not serve a
    // snapshot fetched with the old address or token.
    clearBinsCache(active.camp.id);
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
  children,
}: {
  feature: {
    key: FeatureKey;
    label: string;
    description: string;
    requires: FeatureKey[];
    state: FeatureState;
  };
  stateOf: (key: FeatureKey) => FeatureState;
  /** Extra setup a feature needs once it's on — revealed in place, and driven
   * by the SAME optimistic state as the control, so it slides open on the
   * click rather than a server round-trip later. */
  children?: ReactNode;
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
      {/* Wraps on purpose: with `nowrap`, the description's flex item refuses
          to shrink past its content (min-width: auto) and shoves the control
          off the right edge on a phone — worse the longer the description.
          Given a basis, the control drops below the text instead, and on a
          normal-width screen the two still share one line. */}
      <Group justify="space-between" align="flex-start" gap="sm">
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
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
          // Never squeezed: the three labels are the whole control.
          style={{ flexShrink: 0 }}
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
      {children ? (
        <Collapse in={state !== "off"} transitionDuration={220}>
          <Divider my="md" />
          {children}
        </Collapse>
      ) : null}
    </Card>
  );
}

/** Where the camp's bins instance lives — shown under the Bins feature card
 * once it's switched on, since the shortcut is useless without an address. */
function BinsConfig({
  bins,
}: {
  bins: {
    baseUrl: string;
    label: string;
    hasCode: boolean;
    hasToken: boolean;
  };
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [baseUrl, setBaseUrl] = useState(bins.baseUrl);
  const [label, setLabel] = useState(bins.label);
  const [accessCode, setAccessCode] = useState("");
  const [apiToken, setApiToken] = useState("");
  const saving = fetcher.state !== "idle";

  const saved = fetcher.data?.ok && !saving;

  return (
    <Stack gap="sm">
      {/* Address and label pair up on anything but a phone; the code sits on
          its own row because it's the one field with a caveat attached. */}
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm" verticalSpacing="sm">
        <TextInput
          size="xs"
          label="Address"
          placeholder="https://i.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Menu label"
          placeholder="Bins"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
      </SimpleGrid>
      <PasswordInput
        size="xs"
        label="Access code"
        description={
          bins.hasCode
            ? "Saved. Type a new one to replace it, or leave blank to keep it."
            : "From your bins site's Settings page — the code its invite link carries. Members get signed straight in; it's never printed on the page."
        }
        placeholder={bins.hasCode ? "••••••••" : "Optional"}
        value={accessCode}
        onChange={(e) => setAccessCode(e.currentTarget.value)}
      />
      <PasswordInput
        size="xs"
        label="Read token"
        description={
          bins.hasToken
            ? "Saved. Type a new one to replace it, or leave blank to keep it."
            : "Optional. A read-scoped integration token from your bins admin page — with one, Supplies can look up which box something is in. Stays on the server."
        }
        placeholder={bins.hasToken ? "••••••••" : "bins_…"}
        value={apiToken}
        onChange={(e) => setApiToken(e.currentTarget.value)}
      />
      {fetcher.data?.error ? (
        <Text size="xs" c="red">
          {fetcher.data.error}
        </Text>
      ) : null}
      <Group justify="flex-end" gap="xs">
        {saved ? (
          <Text size="xs" c="dimmed" mr="auto">
            Saved
          </Text>
        ) : null}
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
        ) : null}
        <Button
          size="xs"
          loading={saving}
          onClick={() =>
            fetcher.submit(
              { intent: "bins", baseUrl, accessCode, apiToken, label },
              { method: "post" },
            )
          }
        >
          Save
        </Button>
      </Group>
    </Stack>
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
          <FeatureCard key={f.key} feature={f} stateOf={stateOf}>
            {f.key === "bins" ? <BinsConfig bins={bins} /> : null}
          </FeatureCard>
        ))}
      </Stack>
    </Container>
  );
}
