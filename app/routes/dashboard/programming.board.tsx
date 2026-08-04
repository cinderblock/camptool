/**
 * Day sheets for the lecture hall.
 *
 * Two physical artefacts, one page:
 *  - **Sign** — one day, big type, minimum words. Someone stands at the
 *    sandwich board out front and copies this onto it by hand, so it has to be
 *    readable at arm's length and contain nothing they'd have to skip.
 *  - **Handout** — the same day with descriptions, for posting inside the hall.
 *
 * Both are print-first: `window.print()` on a phone or laptop should produce
 * something you can tape up, so the print stylesheet drops the app chrome.
 *
 * Camp-only sessions appear on the handout but are flagged, because they still
 * occupy the hall while not belonging on a public-facing sign.
 */
import { Badge, Button, Container, Group, Stack, Text } from "@mantine/core";
import { Link, useSearchParams } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { redact } from "~/lib/privacy.server";
import { offeringKindLabel, presenterName } from "~/lib/programming";
import { loadDaySheet } from "~/lib/programming.server";
import { dateLabel, timeRangeLabel, todayIso } from "~/lib/schedule";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/programming.board";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Day sheet · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "programming");
  const sessions = await loadDaySheet(active.camp.id, activeEdition.id);
  return redact(privacy, {
    sessions: sessions.filter((s) => s.sessionStatus !== "cancelled"),
    year: activeEdition.year,
    campName: active.camp.name,
  });
}

export default function ProgrammingBoard({ loaderData }: Route.ComponentProps) {
  const { sessions, year, campName } = loaderData;
  const [params, setParams] = useSearchParams();

  const days = [...new Set(sessions.map((s) => s.date))].sort();
  // Default to today when the event is running — that's the sheet you need
  // while standing in camp — and otherwise to the first day.
  const today = todayIso();
  const requested = params.get("date");
  const date =
    requested && days.includes(requested)
      ? requested
      : days.includes(today)
        ? today
        : (days[0] ?? null);
  const mode = params.get("mode") === "handout" ? "handout" : "sign";

  const items = sessions.filter((s) => s.date === date);
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { preventScrollReset: true });
  };

  const idx = date ? days.indexOf(date) : -1;

  return (
    <Container size="sm" py="md">
      {/* Everything in here is screen-only: the printed sheet is just the day. */}
      <Stack gap="md" className="board-controls">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <div>
            <Text fw={700} size="lg">
              Day sheet · {year}
            </Text>
            <Text size="sm" c="dimmed">
              Print one for the sandwich board out front, or the longer version
              for inside the hall.
            </Text>
          </div>
          <Button variant="light" onClick={() => window.print()}>
            Print
          </Button>
        </Group>

        {days.length === 0 ? null : (
          <Group gap="xs" wrap="wrap">
            <Button
              size="compact-sm"
              variant="default"
              disabled={idx <= 0}
              onClick={() => setParam("date", days[idx - 1] ?? "")}
            >
              ←
            </Button>
            {days.map((d) => (
              <Button
                key={d}
                size="compact-sm"
                variant={d === date ? "filled" : "default"}
                onClick={() => setParam("date", d)}
              >
                {dateLabel(d)}
              </Button>
            ))}
            <Button
              size="compact-sm"
              variant="default"
              disabled={idx < 0 || idx >= days.length - 1}
              onClick={() => setParam("date", days[idx + 1] ?? "")}
            >
              →
            </Button>
          </Group>
        )}

        <Group gap="xs">
          <Button
            size="compact-sm"
            variant={mode === "sign" ? "filled" : "default"}
            onClick={() => setParam("mode", "sign")}
          >
            Sign (big type)
          </Button>
          <Button
            size="compact-sm"
            variant={mode === "handout" ? "filled" : "default"}
            onClick={() => setParam("mode", "handout")}
          >
            Handout (with descriptions)
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            component={Link}
            to="/programming"
          >
            Back to programming
          </Button>
        </Group>
      </Stack>

      {days.length === 0 ? (
        <Text c="dimmed" mt="lg">
          Nothing scheduled yet. Accept an offering and give it a date on the{" "}
          <Link to="/programming">programming page</Link> and it'll show up
          here.
        </Text>
      ) : (
        <Stack
          gap={mode === "sign" ? "lg" : "md"}
          mt="xl"
          className="day-sheet"
        >
          <div>
            <Text
              fw={700}
              style={{ fontSize: mode === "sign" ? 34 : 24, lineHeight: 1.1 }}
            >
              {campName}
            </Text>
            <Text
              fw={700}
              style={{ fontSize: mode === "sign" ? 28 : 20, lineHeight: 1.2 }}
            >
              {date ? dateLabel(date) : ""}
            </Text>
          </div>

          {items.length === 0 ? (
            <Text c="dimmed">Nothing scheduled this day.</Text>
          ) : (
            items.map((s) => (
              <div key={s.sessionId}>
                <Group gap="sm" align="baseline" wrap="wrap">
                  <Text
                    fw={700}
                    style={{ fontSize: mode === "sign" ? 26 : 17 }}
                  >
                    {timeRangeLabel(s.startTime, s.endTime) || "—"}
                  </Text>
                  <Text
                    fw={600}
                    style={{ fontSize: mode === "sign" ? 26 : 17 }}
                  >
                    {s.title}
                  </Text>
                  {/* Not for the sign out front, but it's still using the hall. */}
                  {!s.isPublic ? (
                    <Badge size="sm" color="orange" variant="light">
                      camp only
                    </Badge>
                  ) : null}
                </Group>
                <Text
                  c="dimmed"
                  style={{ fontSize: mode === "sign" ? 20 : 14 }}
                >
                  {[
                    s.presenters.length
                      ? `with ${s.presenters.map(presenterName).join(", ")}`
                      : null,
                    offeringKindLabel(s.kind),
                    s.location,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                {mode === "handout" && s.description ? (
                  <Text size="sm" mt={4}>
                    {s.description}
                  </Text>
                ) : null}
              </div>
            ))
          )}
        </Stack>
      )}

      <style>{`
        @media print {
          .board-controls { display: none !important; }
          /* The app shell (nav, header, banners) is not part of the sheet. */
          header, nav, .mantine-AppShell-header, .mantine-AppShell-navbar { display: none !important; }
          .mantine-AppShell-main { padding: 0 !important; }
          .day-sheet { margin-top: 0 !important; }
          @page { margin: 12mm; }
        }
      `}</style>
    </Container>
  );
}
