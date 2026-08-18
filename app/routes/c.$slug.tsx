import {
  Alert,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { eq } from "drizzle-orm";
import { useState } from "react";
import { data, useFetcher } from "react-router";
import { AuthInline } from "~/components/AuthInline";
import { CampHero } from "~/components/CampHero";
import { PlayaNameField } from "~/components/PlayaNameField";
import { QuestionField } from "~/components/QuestionField";
import { discordEnabled } from "~/lib/auth.server";
import { getFeatureState } from "~/lib/features.server";
import {
  getInstanceSettings,
  setSignupUnlockCookie,
} from "~/lib/instance.server";
import { linkApplicationToProspect } from "~/lib/prospects.server";
import { type QuestionType, isAnswered, parseOptions } from "~/lib/questions";
import { loadApplicationQuestions } from "~/lib/questions.server";
import { isMemberOf, pendingApplicationWhere } from "~/lib/recruits.server";
import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { camp, recruitApplication } from "../../db/schema";
import type { Route } from "./+types/c.$slug";

export function meta({ data: d }: Route.MetaArgs) {
  const name = d?.campName ?? "Camp";
  return [{ title: `Join ${name} · CampTool` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const [found] = await db
    .select({
      id: camp.id,
      name: camp.name,
      logo: camp.logo,
      description: camp.description,
    })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });
  // The public page exists only while Recruiting is fully ON — preview means
  // "officers exploring internally", which must not publish a public surface.
  // 404 (not a bounce): there's no session here, and a camp that turned
  // recruiting off shouldn't advertise that the page ever existed.
  if ((await getFeatureState(found.id, "recruiting")) !== "on") {
    throw data("Camp not found", { status: 404 });
  }

  // The camp's application-surfaced questions, rendered as part of the form.
  const questions = (await loadApplicationQuestions(found.id)).map((q) => ({
    id: q.id,
    prompt: q.prompt,
    helpText: q.helpText,
    type: q.type as QuestionType,
    options: parseOptions(q.options),
    required: q.required,
    exclusiveOption: q.exclusiveOption,
  }));

  const session = await getSession(request);
  if (!session) {
    const payload = {
      campName: found.name,
      logo: found.logo,
      description: found.description,
      slug: params.slug,
      viewer: null,
      alreadyMember: false,
      alreadyApplied: false,
      discordEnabled,
      questions,
    };
    // The public apply page is a sanctioned signup entry point. Only when the
    // instance is in invite-only mode do we drop the signup-unlock cookie that
    // lets a new account be created; in open mode we set nothing so behavior is
    // unchanged.
    const { allowOpenSignups } = await getInstanceSettings();
    if (allowOpenSignups) return payload;
    return data(payload, {
      headers: { "Set-Cookie": setSignupUnlockCookie() },
    });
  }

  const [pending] = await db
    .select({ id: recruitApplication.id })
    .from(recruitApplication)
    .where(pendingApplicationWhere(session.user, found.id))
    .limit(1);

  return {
    campName: found.name,
    logo: found.logo,
    description: found.description,
    slug: params.slug,
    viewer: { name: session.user.name, email: session.user.email },
    alreadyMember: await isMemberOf(session.user.id, found.id),
    alreadyApplied: Boolean(pending),
    discordEnabled,
    questions,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = await getSession(request);
  if (!session) {
    return data({ error: "Please sign in to apply." }, { status: 401 });
  }

  const [found] = await db
    .select({ id: camp.id })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });
  // Same gate as the loader: no applications while recruiting isn't fully on.
  if ((await getFeatureState(found.id, "recruiting")) !== "on") {
    throw data("Camp not found", { status: 404 });
  }

  if (await isMemberOf(session.user.id, found.id)) {
    return data({ error: "You're already a member of this camp." });
  }

  const [pending] = await db
    .select({ id: recruitApplication.id })
    .from(recruitApplication)
    .where(pendingApplicationWhere(session.user, found.id))
    .limit(1);
  if (pending) {
    return data({
      ok: "You've already applied — the camp will be in touch. Hang tight!",
    });
  }

  const form = await request.formData();
  const playaName = String(form.get("playaName") ?? "").trim() || null;
  const message = String(form.get("message") ?? "").trim() || null;

  // Application-surfaced questionnaire answers, JSON {questionId: value}.
  // Only known question ids are kept; required ones must actually be answered.
  // Held on the application (no membership exists yet) and imported into
  // question_answer once they have one.
  const appQuestions = await loadApplicationQuestions(found.id);
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(String(form.get("answers") ?? "{}"));
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v;
  } catch {
    // Malformed answers JSON is treated as empty — required checks below catch it.
  }
  const answers: Record<string, string> = {};
  for (const q of appQuestions) {
    const v = raw[q.id];
    if (typeof v === "string" && v !== "") answers[q.id] = v;
  }
  const missing = appQuestions.filter(
    (q) => q.required && !isAnswered(q.type, answers[q.id]),
  );
  if (missing.length > 0) {
    return data(
      {
        error: `Please answer: ${missing.map((q) => `“${q.prompt}”`).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const applicationId = crypto.randomUUID();
  await db.insert(recruitApplication).values({
    id: applicationId,
    campId: found.id,
    name: session.user.name,
    email: session.user.email,
    playaName,
    answers: Object.keys(answers).length > 0 ? JSON.stringify(answers) : null,
    message,
    status: "pending",
    userId: session.user.id,
  });

  // One pipeline: if an officer has been talking to this person for months on
  // Facebook, the application lands on that same thread rather than starting a
  // second, contextless record. No-ops when the Prospects feature is off, and
  // never throws — losing the application would be far worse than losing the
  // CRM link. See plans/prospects-crm.md.
  if ((await getFeatureState(found.id, "prospects")) !== "off") {
    await linkApplicationToProspect({
      campId: found.id,
      applicationId,
      name: session.user.name,
      email: session.user.email,
      playaName,
    });
  }

  return data({ ok: `Thanks, ${session.user.name}! Your application is in.` });
}

type FetcherData = { ok?: string; error?: string };

export default function PublicCamp({ loaderData }: Route.ComponentProps) {
  const { campName, logo, description } = loaderData;

  return (
    <Container component="main" id="main-content" size="sm" py="xl">
      <Stack gap="lg">
        <CampHero
          name={campName}
          logo={logo}
          description={description}
          tagline="Interested in joining? Tell us a bit about yourself and the camp will reach out."
        />

        <Paper withBorder radius="md" p="lg">
          {loaderData.viewer ? (
            <ApplySection {...loaderData} viewer={loaderData.viewer} />
          ) : (
            <AuthInline
              intro="Create an account to apply — so you can sign back in later and check on your application."
              discordEnabled={loaderData.discordEnabled}
            />
          )}
        </Paper>
      </Stack>
    </Container>
  );
}

function ApplySection({
  campName,
  viewer,
  alreadyMember,
  alreadyApplied,
  questions,
}: {
  campName: string;
  viewer: { name: string; email: string };
  alreadyMember: boolean;
  alreadyApplied: boolean;
  questions: Route.ComponentProps["loaderData"]["questions"];
}) {
  const fetcher = useFetcher<FetcherData>();
  const result = fetcher.data;
  const submitting = fetcher.state !== "idle";
  // Question answers collected locally (QuestionField's onSave mode) and
  // submitted with the rest of the form as one JSON field.
  const [answers, setAnswers] = useState<Record<string, string>>({});

  if (alreadyMember) {
    return (
      <Alert color="green" title="You're in">
        You're already a member of {campName}.
      </Alert>
    );
  }
  if (alreadyApplied || result?.ok) {
    return (
      <Alert color="green" title="Application received">
        <Stack gap={6}>
          <Text size="sm">
            {result?.ok ?? "You've already applied — hang tight!"}
          </Text>
          <Text size="sm">
            The camp will reach out at <b>{viewer.email}</b>. You can revisit
            this page any time to check where things stand.
          </Text>
        </Stack>
      </Alert>
    );
  }

  return (
    <fetcher.Form method="post">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Applying as <b>{viewer.name}</b> ({viewer.email}).
        </Text>
        {result?.error ? (
          <Alert color="red" title="Check your application">
            {result.error}
          </Alert>
        ) : null}
        <PlayaNameField name="playaName" />
        {questions.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={answers[q.id]}
            locked={false}
            onSave={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
          />
        ))}
        <input type="hidden" name="answers" value={JSON.stringify(answers)} />
        <Textarea
          name="message"
          label="Why do you want to join?"
          placeholder="A sentence or two about you and what you're looking for."
          autosize
          minRows={3}
        />
        <Group justify="flex-end">
          <Button type="submit" loading={submitting}>
            Apply to join
          </Button>
        </Group>
      </Stack>
    </fetcher.Form>
  );
}
