/**
 * Bringing a camp here from another CampTool install
 * (plans/camp-portability.md). The camp's admin there starts the move and gets
 * a move code; here they paste it, check what would happen, and import.
 *
 * Who may import: anyone who may start a camp here (decision 9: open camp
 * registration, a setup link via `?link=`, or a super admin), and only if they
 * are one of the camp's admins in the bundle (or a super admin). The check
 * shows nobody's details until that holds.
 *
 * Lives outside the app shell, on the apex, like /new-camp.
 */
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  FileInput,
  Group,
  List,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { eq } from "drizzle-orm";
import { data, Form, redirect, useNavigation } from "react-router";
import { blobs } from "~/lib/blobs.server";
import {
  claimSetupLink,
  findSetupLink,
  recordSetupLinkCamp,
  setupLinkState,
} from "~/lib/camp-admin.server";
import { campOrigin } from "~/lib/camp-host";
import {
  applyImport,
  loadRows,
  type Preflight,
  preflight,
} from "~/lib/camp-move/import.server";
import {
  bundleFromFile,
  confirmToSource,
  type FetchedBundle,
  MoveFetchError,
  pullBundle,
} from "~/lib/camp-move/move-in.server";
import { APEX, CAMP_SUBDOMAINS } from "~/lib/env.server";
import { getInstanceSettings, isSuperAdmin } from "~/lib/instance.server";
import { getRealSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { session as sessionTable } from "../../db/schema";
import type { Route } from "./+types/import-camp";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Import a camp · CampTool" }];
}

const UPLOADS = "_imports/";
const UPLOAD_TTL_MS = 86_400_000;

async function gate(request: Request) {
  const session = await getRealSession(request);
  const url = new URL(request.url);
  const linkToken = url.searchParams.get("link");
  if (!session) {
    throw redirect(
      `/login?next=${encodeURIComponent(url.pathname + url.search)}`,
    );
  }
  const superAdmin = await isSuperAdmin(session.user.id);
  let link: Awaited<ReturnType<typeof findSetupLink>> = null;
  if (linkToken) {
    link = await findSetupLink(linkToken);
    if (!link || setupLinkState(link) !== "ok") {
      throw data("This setup link can't be used.", { status: 403 });
    }
  } else if (!superAdmin && !(await getInstanceSettings()).allowCampCreation) {
    throw data("Bringing a camp here needs a setup link.", { status: 403 });
  }
  return { session, superAdmin, link };
}

export async function loader({ request }: Route.LoaderArgs) {
  const { session, link } = await gate(request);
  return {
    viewer: { name: session.user.name, email: session.user.email },
    apexHost: CAMP_SUBDOMAINS ? APEX.host : null,
    linkSlug: link?.slug ?? null,
  };
}

type Person = {
  name: string;
  email: string;
  role: string | null;
  outcome: string;
  why: string;
};

export type ActionResult =
  | { stage: "error"; error: string }
  | {
      stage: "review";
      code: string;
      upload: string | null;
      confirmed: boolean;
      sourceCampUrl: string;
      report: Pick<
        Preflight,
        "problems" | "warnings" | "camp" | "rows" | "files"
      > & { people: Person[] };
    }
  | {
      stage: "done";
      campUrl: string;
      campName: string;
      told: boolean;
      sourceCampUrl: string;
      claims: number;
    };

/** Drop bundle files left by checks that never went on to import. */
async function sweepUploads() {
  const now = Date.now();
  for (const f of await blobs.list()) {
    if (!f.key.startsWith(UPLOADS)) continue;
    const at = Number(f.key.slice(UPLOADS.length).split("-")[0]);
    if (!at || now - at > UPLOAD_TTL_MS) await blobs.delete(f.key);
  }
}

async function fetchBundle(
  code: string,
  upload: string | null,
): Promise<FetchedBundle> {
  if (!upload) return pullBundle(code);
  if (!upload.startsWith(UPLOADS) || upload.includes("..")) {
    throw new MoveFetchError("That upload is gone. Choose the file again.");
  }
  const blob = await blobs.get(upload);
  if (!blob)
    throw new MoveFetchError("That upload is gone. Choose the file again.");
  return bundleFromFile(await blob.bytes(), code);
}

export async function action({
  request,
}: Route.ActionArgs): Promise<ActionResult> {
  const { session, superAdmin, link } = await gate(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "check");
  const code = String(form.get("code") ?? "").trim();
  let upload = (form.get("upload") as string | null) || null;

  try {
    if (intent === "check") {
      await sweepUploads();
      const file = form.get("file");
      if (file instanceof File && file.size > 0) {
        upload = `${UPLOADS}${Date.now()}-${crypto.randomUUID()}`;
        await blobs.put(upload, new Uint8Array(await file.arrayBuffer()));
      }
    }
    const fetched = await fetchBundle(code, upload);
    const { rows, problems } = await loadRows(
      fetched.source,
      fetched.trustedKey,
    );
    const slug = link?.slug ?? (String(form.get("slug") ?? "") || undefined);
    const plan = problems.length
      ? null
      : await preflight(fetched.source, rows, {
          slug,
          importer: { id: session.user.id, email: session.user.email },
        });

    const allProblems = [...problems, ...(plan?.problems ?? [])];
    // Only the camp's own admin (or a site admin) gets to see its people.
    const me = plan?.people.find((p) => p.userId === session.user.id);
    if (plan && !allProblems.length && !superAdmin && me?.role !== "admin") {
      allProblems.push(
        "Only one of the camp's admins can bring it here. Sign in here with the same address you use there.",
      );
    }
    const blocked = allProblems.length > 0;

    if (intent === "import" && plan && !blocked && !plan.camp.slugProblem) {
      const done = await applyImport(fetched.source, rows, plan, {
        importedByUserId: session.user.id,
      });
      if (link) {
        await claimSetupLink(link.id, session.user.id);
        await recordSetupLinkCamp(link.id, done.campId);
      }
      if (upload) await blobs.delete(upload);
      const campUrl = CAMP_SUBDOMAINS
        ? `${campOrigin(done.slug, APEX)}/`
        : `${APEX.origin}/`;
      const told = await confirmToSource(fetched.code, {
        origin: APEX.origin,
        campUrl,
      });
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: done.campId })
        .where(eq(sessionTable.id, session.session.id));
      return {
        stage: "done",
        campUrl,
        campName: plan.camp.name,
        told,
        sourceCampUrl: fetched.source.manifest.source.campUrl,
        claims: plan.people.filter((p) => p.outcome === "claim").length,
      };
    }

    return {
      stage: "review",
      code,
      upload,
      confirmed: fetched.confirmed,
      sourceCampUrl: fetched.source.manifest.source.campUrl,
      report: {
        problems: allProblems,
        warnings: plan?.warnings ?? [],
        camp: plan?.camp ?? {
          id: fetched.source.manifest.camp.id,
          name: fetched.source.manifest.camp.name,
          slug: "",
          slugProblem: null,
        },
        rows: plan?.rows ?? 0,
        files: plan?.files ?? 0,
        people: blocked
          ? []
          : (plan?.people ?? []).map((p) => ({
              name: p.name,
              email: p.email,
              role: p.role,
              outcome: p.outcome,
              why: p.why,
            })),
      },
    };
  } catch (e) {
    return {
      stage: "error",
      error: e instanceof Error ? e.message : "Something went wrong.",
    };
  }
}

const OUTCOME: Record<string, { label: string; color: string }> = {
  create: { label: "New here", color: "teal" },
  link: { label: "Already here", color: "blue" },
  claim: { label: "Must claim", color: "orange" },
};

export default function ImportCamp({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const result = actionData as ActionResult | undefined;

  if (result?.stage === "done") {
    return (
      <Shell>
        <Alert color="teal" title={`${result.campName} is here`}>
          <Stack gap="xs">
            <Text size="sm">
              Everyone's sign-ins from the old site keep working here for a
              year: they'll be asked to make a passkey for this site the first
              time they arrive.
            </Text>
            {result.claims > 0 && (
              <Text size="sm">
                {result.claims}{" "}
                {result.claims === 1 ? "person has" : "people have"} an account
                here already that couldn't be proven to be them. They claim it
                by signing in on the old site once and following the link.
              </Text>
            )}
            {!result.told && (
              <Text size="sm">
                The old site couldn't be told. Ask its admin to mark the move
                done ({result.sourceCampUrl}, Camp settings → Move this camp),
                with this address: <b>{result.campUrl}</b>
              </Text>
            )}
          </Stack>
        </Alert>
        <Button component="a" href={result.campUrl}>
          Open {result.campName}
        </Button>
      </Shell>
    );
  }

  if (result?.stage === "review") {
    const r = result.report;
    const blocked = r.problems.length > 0;
    return (
      <Shell>
        <Text size="sm">
          From <b>{result.sourceCampUrl}</b>
          {!result.confirmed &&
            " (couldn't reach it to confirm the file is really from there)"}
          : <b>{r.camp.name}</b>, {r.rows} rows and {r.files} files.
        </Text>
        {blocked && (
          <Alert color="red" title="Can't import this">
            <List size="sm">
              {r.problems.map((p) => (
                <List.Item key={p}>{p}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        {r.warnings.length > 0 && (
          <Alert color="yellow" title="Worth knowing">
            <List size="sm">
              {r.warnings.map((w) => (
                <List.Item key={w}>{w}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        {!blocked && (
          <Form method="post">
            <input type="hidden" name="intent" value="import" />
            <input type="hidden" name="code" value={result.code} />
            {result.upload && (
              <input type="hidden" name="upload" value={result.upload} />
            )}
            <Stack gap="md">
              <TextInput
                name="slug"
                label="Address here"
                description={
                  loaderData.apexHost
                    ? `The camp will be at <address>.${loaderData.apexHost}`
                    : undefined
                }
                defaultValue={r.camp.slug}
                readOnly={!!loaderData.linkSlug}
                error={r.camp.slugProblem}
              />
              <Table striped withTableBorder fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Person</Table.Th>
                    <Table.Th>Here</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {r.people.map((p) => (
                    <Table.Tr key={p.email}>
                      <Table.Td>
                        <Text size="sm">{p.name}</Text>
                        <Text size="xs" c="dimmed">
                          {p.email}
                          {p.role ? ` · ${p.role}` : ""}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={OUTCOME[p.outcome]?.color}
                          variant="light"
                        >
                          {OUTCOME[p.outcome]?.label ?? p.outcome}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {p.why}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Group justify="space-between">
                <Anchor href="/import-camp" size="sm">
                  Start over
                </Anchor>
                <Button type="submit" loading={busy}>
                  {r.camp.slugProblem ? "Check again" : "Import the camp"}
                </Button>
              </Group>
            </Stack>
          </Form>
        )}
        {blocked && (
          <Anchor href="/import-camp" size="sm">
            Start over
          </Anchor>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <Text size="sm" c="dimmed">
        Moving a camp here from another CampTool site? Its admin starts the move
        there (Camp settings → Move this camp) and gets a move code. Paste it
        here. Nothing is imported until you've checked what will happen.
      </Text>
      {result?.stage === "error" && (
        <Alert color="red" title="That didn't work">
          {result.error}
        </Alert>
      )}
      <Form method="post" encType="multipart/form-data">
        <input type="hidden" name="intent" value="check" />
        <Stack gap="md">
          <Textarea
            name="code"
            label="Move code"
            placeholder="camptool-move:1:…"
            required
            autosize
            minRows={2}
            styles={{ input: { fontFamily: "monospace" } }}
          />
          <FileInput
            name="file"
            label="Bundle file (only if the old site can't be reached)"
            description="The .camptool file its admin downloaded."
            clearable
          />
          <Button type="submit" loading={busy}>
            Check
          </Button>
        </Stack>
      </Form>
      <Text size="xs" c="dimmed">
        Signed in as {loaderData.viewer.name} ({loaderData.viewer.email}).
      </Text>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Container component="main" id="main-content" size={640} py="xl">
      <Title order={1} size="h2" ta="center">
        Bring a camp here
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Stack gap="md">{children}</Stack>
      </Paper>
    </Container>
  );
}
