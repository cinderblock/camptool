import dayjs from "dayjs";
import { useEffect, useState } from "react";

// Shows an ISO instant in the viewer's own time zone. The server doesn't know
// that zone, so the first render (server and hydration) shows UTC, labelled,
// and the browser swaps in local time after mount.
export function LocalTime({
  iso,
  format = "YYYY-MM-DD HH:mm",
}: {
  iso: string;
  format?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <time dateTime={iso}>
      {mounted
        ? dayjs(iso).format(format)
        : `${iso.slice(0, 16).replace("T", " ")} UTC`}
    </time>
  );
}
