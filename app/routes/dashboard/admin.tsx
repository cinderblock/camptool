import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef } from "react";
import { data, redirect, useFetcher } from "react-router";
import {
  getInstanceSettings,
  grantSuperAdminByEmail,
  isSuperAdmin,
  listSuperAdmins,
  revokeSuperAdmin,
  setInstanceSettings,
} from "~/lib/instance.server";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/admin";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Site admin · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/dashboard");

  const [settings, admins] = await Promise.all([
    getInstanceSettings(),
    listSuperAdmins(),
  ]);

  return {
    settings,
    currentUserId: session.user.id,
    admins: admins.map((a) => ({
      userId: a.userId,
      name: a.name,
      email: a.email,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/dashboard");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "toggle") {
    const field = String(form.get("field") ?? "");
    const value = String(form.get("value") ?? "") === "true";
    if (field !== "allowCampCreation" && field !== "allowOpenSignups") {
      return data({ error: "Unknown setting." }, { status: 400 });
    }
    await setInstanceSettings({ [field]: value });
    return data({ ok: true });
  }

  if (intent === "addAdmin") {
    const email = String(form.get("email") ?? "");
    const res = await grantSuperAdminByEmail(email);
    if (!res.ok) return data({ error: res.reason }, { status: 400 });
    return data({ ok: true, message: "Super admin added." });
  }

  if (intent === "removeAdmin") {
    const userId = String(form.get("userId") ?? "");
    const res = await revokeSuperAdmin(userId);
    if (!res.ok) return data({ error: res.reason }, { status: 400 });
    return data({ ok: true, message: "Super admin removed." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function SiteAdmin({ loaderData }: Route.ComponentProps) {
  const { settings, admins, currentUserId } = loaderData;

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Title order={2}>Site administration</Title>
          <Text c="dimmed">
            Deployment-wide controls. These apply to the whole CampTool
            instance, not a single camp.
          </Text>
        </div>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Lockdowns</Title>
            <ToggleRow
              field="allowCampCreation"
              checked={settings.allowCampCreation}
              label="Allow new camp creation"
              description="When off, only super admins can create new camps."
            />
            <ToggleRow
              field="allowOpenSignups"
              checked={settings.allowOpenSignups}
              label="Allow open sign-ups"
              description="When off, new accounts are invite-only — only people who follow a camp invite link or a camp's public apply page can register."
            />
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Super admins</Title>
            <Text size="sm" c="dimmed">
              Super admins can change these settings and always bypass the
              lockdowns. To add one, the person must have signed in here at
              least once.
            </Text>
            <AdminTable admins={admins} currentUserId={currentUserId} />
            <AddAdminForm />
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}

function ToggleRow({
  field,
  checked,
  label,
  description,
}: {
  field: string;
  checked: boolean;
  label: string;
  description: string;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  // Reflect the in-flight value optimistically so the switch feels responsive.
  const pending = fetcher.formData?.get("value");
  const value = pending != null ? pending === "true" : checked;

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't save",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]);

  return (
    <Switch
      checked={value}
      label={label}
      description={description}
      onChange={(e) =>
        fetcher.submit(
          { intent: "toggle", field, value: String(e.currentTarget.checked) },
          { method: "post" },
        )
      }
    />
  );
}

function AdminTable({
  admins,
  currentUserId,
}: {
  admins: { userId: string; name: string; email: string }[];
  currentUserId: string;
}) {
  const fetcher = useFetcher<{ error?: string; message?: string }>();

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't remove",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]);

  return (
    <Table>
      <Table.Tbody>
        {admins.map((a) => (
          <Table.Tr key={a.userId}>
            <Table.Td>
              <Text fw={500}>{a.name}</Text>
              <Text size="xs" c="dimmed">
                {a.email}
              </Text>
            </Table.Td>
            <Table.Td ta="right">
              {a.userId === currentUserId ? (
                <Badge variant="light" color="gray">
                  you
                </Badge>
              ) : (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  loading={
                    fetcher.state !== "idle" &&
                    fetcher.formData?.get("userId") === a.userId
                  }
                  onClick={() =>
                    fetcher.submit(
                      { intent: "removeAdmin", userId: a.userId },
                      { method: "post" },
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function AddAdminForm() {
  const fetcher = useFetcher<{ error?: string; message?: string }>();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't add",
        message: fetcher.data.error,
      });
    } else if (fetcher.data?.message) {
      notifications.show({
        title: "Super admins",
        message: fetcher.data.message,
      });
      ref.current?.reset();
    }
  }, [fetcher.data]);

  return (
    <fetcher.Form method="post" ref={ref}>
      <input type="hidden" name="intent" value="addAdmin" />
      <Group align="flex-end" gap="sm">
        <TextInput
          name="email"
          type="email"
          label="Add a super admin by email"
          placeholder="person@example.com"
          style={{ flex: 1 }}
          required
        />
        <Button type="submit" loading={fetcher.state !== "idle"}>
          Add
        </Button>
      </Group>
    </fetcher.Form>
  );
}
