/**
 * The responses page as a spreadsheet — one row per person, one column per
 * question. Officers end up pulling this into a sheet to sort and pivot it, and
 * shipping the export is cheaper than growing the page into a spreadsheet.
 *
 * Shares `loadResponseMatrix` with the page, so the two can't drift on answer
 * precedence or audience.
 */
import { data } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { displayAnswer, questionApplies } from "~/lib/questions";
import { loadResponseMatrix } from "~/lib/questions.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/questions.responses.csv";

/** RFC 4180: quote everything and double any embedded quote. Answers are free
 * text with commas and newlines in them, so this is not optional. */
function cell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "questions");
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }

  const matrix = await loadResponseMatrix({
    campId: active.camp.id,
    editionId: activeEdition.id,
  });
  // Redacted like any loader payload rather than refused outright (the way
  // export-db refuses): a pseudonymized spreadsheet is still a useful demo,
  // where raw database bytes are not. Kept on one line so the textual guard in
  // privacy-coverage.test.ts can see it.
  const { questions, members } = redact(privacy, matrix);

  const header = [
    "Name",
    "Playa name",
    "Email",
    "Role",
    ...questions.map((q) => q.prompt),
  ];
  const rows = members.map((m) => [
    m.name,
    m.playaName ?? "",
    m.email,
    m.role,
    // A blank cell is ambiguous between "didn't answer" and "not asked", so
    // say which — the whole point of the audience tag.
    ...questions.map((q) =>
      questionApplies(q, m)
        ? displayAnswer(q.type, m.answers[q.id]?.value)
        : "n/a",
    ),
  ]);

  // BOM so Excel opens UTF-8 (playa names are full of accents and emoji)
  // without mangling it.
  const csv = `﻿${[header, ...rows]
    .map((r) => r.map(cell).join(","))
    .join("\r\n")}\r\n`;

  const slug = (active.camp.slug ?? "camp").replace(/[^a-z0-9-]/gi, "");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-responses-${activeEdition.year}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
