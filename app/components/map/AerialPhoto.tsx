/**
 * Aerial photo under the camp map (see plans/map-aerial-photo.md).
 *
 *   AerialLayer  the SVG drawing, inside the map's own <svg>, in its px frame.
 *   AerialPanel  the side-rail card: show/hide for everyone; upload, opacity,
 *                crop, two-point alignment and fine adjustment for officers.
 *
 * Alignment is a two-point fit: click a feature in the photo, then the same
 * thing on the map, twice. That fixes move + turn + scale in one go — the
 * photo is what got built and the map is the plan, so "line them up" is a
 * judgement about which two things to trust, and that judgement is the
 * officer's.
 */
import {
  Alert,
  Button,
  Checkbox,
  FileButton,
  Group,
  NumberInput,
  Paper,
  RangeSlider,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  type AerialRow,
  type Pt,
  fitTwoPoints,
  imageToPlot,
  initialTransform,
  plotToImage,
  seedRotation,
} from "~/lib/aerial";
import { bearingFromMan } from "~/lib/brc";
import { prepareUpload } from "~/lib/images.client";

/** An alignment in progress: photo/map points alternate, photo first. */
export type AerialPick = { aerialId: string; img: Pt[]; plot: Pt[] };

/** Which kind of click the alignment wants next. */
export function pickWants(p: AerialPick): "photo" | "map" {
  return p.img.length === p.plot.length ? "photo" : "map";
}

const src = (a: AerialRow, full: boolean) =>
  full || !a.hasDisplay ? `/media/${a.imageId}/full` : `/media/${a.imageId}`;

/**
 * Draws the photos. Tagged `data-map-aerial` so the Burning Man export strips
 * it — a placement submission is the plan, not a photo of last year.
 *
 * `over` is the alignment's "click on the photo" step: the photo is drawn
 * again on top of everything, opaque, so the feature being clicked is what's
 * actually visible.
 */
export function AerialLayer({
  aerials,
  originX,
  originY,
  ppf,
  zoom,
  pick,
  over = false,
}: {
  aerials: AerialRow[];
  originX: number;
  originY: number;
  ppf: number;
  zoom: number;
  pick: AerialPick | null;
  over?: boolean;
}) {
  const sx = (x: number) => originX + x * ppf;
  const sy = (y: number) => originY + y * ppf;
  const shown = over ? aerials.filter((a) => a.id === pick?.aerialId) : aerials;
  // Past 2× the 1600px display copy is visibly soft; layer the original on top
  // (the display copy stays underneath so nothing blanks while it loads).
  const sharp = zoom >= 2;
  const picked = pick ? aerials.find((a) => a.id === pick.aerialId) : null;
  const r = 7 / zoom;
  return (
    <g data-map-aerial="" pointerEvents="none">
      {shown.map((a) => {
        const w = a.pxWidth;
        const h = a.pxHeight;
        const clip = `aerial-crop-${over ? "over-" : ""}${a.id}`;
        const opacity = over
          ? 1
          : pick?.aerialId === a.id
            ? Math.min(a.opacity, 0.6)
            : a.opacity;
        return (
          <g
            key={a.id}
            transform={`translate(${sx(a.cx)} ${sy(a.cy)}) rotate(${a.rotation}) scale(${a.ftPerPx * ppf})`}
            opacity={opacity}
          >
            <clipPath id={clip}>
              <rect
                x={-w / 2 + a.cropX0 * w}
                y={-h / 2 + a.cropY0 * h}
                width={(a.cropX1 - a.cropX0) * w}
                height={(a.cropY1 - a.cropY0) * h}
              />
            </clipPath>
            <g clipPath={`url(#${clip})`}>
              <image
                href={src(a, false)}
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                preserveAspectRatio="none"
              />
              {sharp && a.hasDisplay ? (
                <image
                  href={src(a, true)}
                  x={-w / 2}
                  y={-h / 2}
                  width={w}
                  height={h}
                  preserveAspectRatio="none"
                />
              ) : null}
            </g>
          </g>
        );
      })}
      {/* Alignment markers: ring = picked on the photo, dot = picked on the
          map, joined so it's clear which pairs with which. */}
      {picked && pick
        ? pick.img.map((ip, i) => {
            const p = imageToPlot(picked, ip);
            const m = pick.plot[i];
            const key = `pick-${i}-${ip.x}-${ip.y}`;
            return (
              <g key={key}>
                {m ? (
                  <line
                    x1={sx(p.x)}
                    y1={sy(p.y)}
                    x2={sx(m.x)}
                    y2={sy(m.y)}
                    stroke="#f783ac"
                    strokeWidth={2 / zoom}
                    strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                  />
                ) : null}
                <circle
                  cx={sx(p.x)}
                  cy={sy(p.y)}
                  r={r}
                  fill="none"
                  stroke="#22b8cf"
                  strokeWidth={2.5 / zoom}
                />
                <text
                  x={sx(p.x) + r * 1.4}
                  y={sy(p.y) - r * 1.4}
                  fontSize={12 / zoom}
                  fontWeight={700}
                  fill="#22b8cf"
                >
                  {i + 1}
                </text>
                {m ? (
                  <circle
                    cx={sx(m.x)}
                    cy={sy(m.y)}
                    r={r * 0.6}
                    fill="#f783ac"
                    stroke="#fff"
                    strokeWidth={1.5 / zoom}
                  />
                ) : null}
              </g>
            );
          })
        : null}
    </g>
  );
}

type Orientation = "twelve" | "north" | "map";

/** Compass bearing a photo's "up" points at, or null = "already matches". */
function orientationBearing(o: Orientation): number | null {
  if (o === "twelve") return bearingFromMan(12);
  if (o === "north") return 0;
  return null;
}

export function AerialPanel({
  aerials,
  lot,
  mapUpBearing,
  burningMan,
  canManage,
  isShown,
  setShown,
  onDraft,
  pick,
  setPick,
}: {
  aerials: AerialRow[];
  lot: { frontageFt: number; depthFt: number };
  mapUpBearing: number | null;
  burningMan: boolean;
  canManage: boolean;
  /** This viewer's show/hide, over the officer-set default. */
  isShown: (a: AerialRow) => boolean;
  setShown: (id: string, on: boolean) => void;
  /** Live, unsaved change while a control is moving. */
  onDraft: (id: string, patch: Partial<AerialRow>) => void;
  pick: AerialPick | null;
  setPick: (p: AerialPick | null) => void;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [orientation, setOrientation] = useState<Orientation>(
    burningMan ? "twelve" : "north",
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const serverError = fetcher.data?.error ?? null;

  const save = (
    id: string,
    fields: Record<string, string | number | boolean>,
  ) => {
    const body: Record<string, string> = {
      intent: "updateAerial",
      aerialId: id,
    };
    for (const [k, v] of Object.entries(fields)) body[k] = String(v);
    fetcher.submit(body, { method: "post" });
  };
  /** Draft now, save once the typing/dragging settles. */
  const change = (id: string, patch: Partial<AerialRow>, delay = 450) => {
    onDraft(id, patch);
    const key = `${id}:${Object.keys(patch).join(",")}`;
    const prev = timers.current.get(key);
    if (prev) clearTimeout(prev);
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        save(id, patch as Record<string, number>);
      }, delay),
    );
  };
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) clearTimeout(id);
    };
  }, []);

  const seedFor = (o: Orientation): number => {
    const up = orientationBearing(o);
    return up == null || mapUpBearing == null
      ? 0
      : seedRotation(up, mapUpBearing);
  };

  async function upload(file: File | null) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const prepared = await prepareUpload(file);
      if (!prepared.width || !prepared.height) {
        throw new Error("Couldn't read that picture — try a PNG or JPEG.");
      }
      const body = new FormData();
      body.set("file", file);
      if (prepared.display)
        body.set("display", prepared.display, "display.webp");
      body.set("width", String(prepared.width));
      body.set("height", String(prepared.height));
      const res = await fetch("/api/media", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !json.id) {
        throw new Error(json.error ?? `Upload failed (${res.status}).`);
      }
      const t = initialTransform({
        pxWidth: prepared.width,
        pxHeight: prepared.height,
        frontageFt: lot.frontageFt,
        depthFt: lot.depthFt,
        rotation: seedFor(orientation),
      });
      fetcher.submit(
        {
          intent: "addAerial",
          imageId: json.id,
          label: file.name.replace(/\.[a-z0-9]{1,5}$/i, ""),
          pxWidth: String(t.pxWidth),
          pxHeight: String(t.pxHeight),
          cx: String(t.cx),
          cy: String(t.cy),
          ftPerPx: String(t.ftPerPx),
          rotation: String(t.rotation),
        },
        { method: "post" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  // Finish a two-point alignment as soon as the fourth click lands. Keyed on
  // the pick alone: the rows and helpers it reads are current at that moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on the pick only
  useEffect(() => {
    if (!pick || pick.plot.length < 2) return;
    const a = aerials.find((x) => x.id === pick.aerialId);
    const [i0, i1] = pick.img;
    const [p0, p1] = pick.plot;
    setPick(null);
    if (!a || !i0 || !i1 || !p0 || !p1) return;
    const fit = fitTwoPoints(a, [i0, i1], [p0, p1]);
    if (!fit) {
      setError("Pick two different features, well apart, and try again.");
      return;
    }
    onDraft(a.id, fit);
    save(a.id, {
      cx: fit.cx,
      cy: fit.cy,
      ftPerPx: fit.ftPerPx,
      rotation: fit.rotation,
    });
  }, [pick]);

  if (!canManage && aerials.length === 0) return null;

  const step = pick ? pick.img.length + pick.plot.length + 1 : 0;
  const stepText = [
    "",
    "Click a feature on the photo — a corner of a big shade, the tip of a structure. Zoom in for precision.",
    "Now click where that same thing is on the map.",
    "Click a second feature on the photo, well away from the first.",
    "And where that one is on the map.",
  ][step];

  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={6}>
        Aerial photo
      </Text>
      <Stack gap="xs">
        {aerials.length === 0 ? (
          <Text size="xs" c="dimmed">
            Lay a drone shot, gigapan or satellite picture of the camp under the
            map, to compare the plan with what actually got built. Only the camp
            sees it.
          </Text>
        ) : null}
        {aerials.map((a) => {
          const isPicking = pick?.aerialId === a.id;
          const adjusting = adjustOpen === a.id;
          return (
            <Stack key={a.id} gap={6}>
              <Checkbox
                size="xs"
                label={a.label || "Aerial photo"}
                checked={isShown(a)}
                onChange={(e) => setShown(a.id, e.currentTarget.checked)}
              />
              {canManage ? (
                <>
                  <Group gap={6} wrap="nowrap" align="center">
                    <Text size="xs" c="dimmed" w={52}>
                      Opacity
                    </Text>
                    <Slider
                      size="xs"
                      style={{ flex: 1 }}
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={a.opacity}
                      label={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => onDraft(a.id, { opacity: v })}
                      onChangeEnd={(v) => save(a.id, { opacity: v })}
                    />
                  </Group>
                  {isPicking ? (
                    <Alert color="cyan" p="xs">
                      <Text size="xs" fw={600}>
                        Step {step} of 4
                      </Text>
                      <Text size="xs">{stepText}</Text>
                      <Button
                        size="compact-xs"
                        variant="default"
                        mt={6}
                        onClick={() => setPick(null)}
                      >
                        Cancel
                      </Button>
                    </Alert>
                  ) : (
                    <Group gap={6}>
                      <Button
                        size="compact-xs"
                        onClick={() => {
                          setError(null);
                          setPick({ aerialId: a.id, img: [], plot: [] });
                        }}
                      >
                        Align by two points
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() => setAdjustOpen(adjusting ? null : a.id)}
                      >
                        {adjusting ? "Done adjusting" : "Adjust"}
                      </Button>
                    </Group>
                  )}
                  {adjusting ? (
                    <AdjustControls
                      a={a}
                      change={change}
                      save={save}
                      onDraft={onDraft}
                      reseed={() => {
                        const rotation = seedFor(orientation);
                        onDraft(a.id, { rotation });
                        save(a.id, { rotation });
                      }}
                      orientationLabel={
                        orientation === "twelve"
                          ? "12:00 up"
                          : orientation === "north"
                            ? "north up"
                            : "as the map"
                      }
                    />
                  ) : null}
                  {adjusting ? (
                    <Group gap={6}>
                      <Checkbox
                        size="xs"
                        label="Shown by default"
                        checked={a.visible}
                        onChange={(e) =>
                          save(a.id, { visible: e.currentTarget.checked })
                        }
                      />
                      {confirmDelete === a.id ? (
                        <Button
                          size="compact-xs"
                          color="red"
                          onClick={() => {
                            setConfirmDelete(null);
                            fetcher.submit(
                              { intent: "deleteAerial", aerialId: a.id },
                              { method: "post" },
                            );
                          }}
                        >
                          Really remove?
                        </Button>
                      ) : (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          onClick={() => setConfirmDelete(a.id)}
                        >
                          Remove
                        </Button>
                      )}
                    </Group>
                  ) : null}
                </>
              ) : null}
            </Stack>
          );
        })}
        {canManage ? (
          <Stack gap={6}>
            <Select
              size="xs"
              label="Which way is up in the photo?"
              value={orientation}
              onChange={(v) => v && setOrientation(v as Orientation)}
              allowDeselect={false}
              data={[
                ...(burningMan
                  ? [{ value: "twelve", label: "12:00 up (gigapan style)" }]
                  : []),
                { value: "north", label: "North up (satellite style)" },
                { value: "map", label: "Already turned to match the map" },
              ]}
            />
            <FileButton
              onChange={upload}
              accept="image/png,image/jpeg,image/webp,image/gif"
            >
              {(props) => (
                <Button
                  {...props}
                  size="xs"
                  variant="light"
                  loading={uploading || fetcher.state !== "idle"}
                >
                  Add aerial photo…
                </Button>
              )}
            </FileButton>
          </Stack>
        ) : null}
        {error || serverError ? (
          <Text size="xs" c="red">
            {error ?? serverError}
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );
}

function AdjustControls({
  a,
  change,
  save,
  onDraft,
  reseed,
  orientationLabel,
}: {
  a: AerialRow;
  change: (id: string, patch: Partial<AerialRow>) => void;
  save: (id: string, fields: Record<string, string | number | boolean>) => void;
  onDraft: (id: string, patch: Partial<AerialRow>) => void;
  reseed: () => void;
  orientationLabel: string;
}) {
  // Scale reads better as px/ft (a photo is "10 pixels to the foot") than as
  // the stored ft/px.
  const pxPerFt = 1 / a.ftPerPx;
  // Turn and scale are about the photo's own centre — "Across"/"Back" —
  // which is what the numbers describe.
  const num = (
    label: string,
    value: number,
    step: number,
    decimals: number,
    onValue: (v: number) => void,
    suffix?: string,
  ) => (
    <NumberInput
      size="xs"
      label={label}
      value={Number(value.toFixed(decimals))}
      step={step}
      decimalScale={decimals}
      suffix={suffix}
      onChange={(v) => {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) onValue(n);
      }}
    />
  );
  return (
    <Stack gap={6}>
      <Group grow gap={6}>
        {num(
          "Turn",
          a.rotation,
          0.5,
          1,
          (v) => change(a.id, { rotation: v }),
          "°",
        )}
        {num(
          "Scale",
          pxPerFt,
          0.1,
          2,
          (v) => v > 0 && change(a.id, { ftPerPx: 1 / v }),
          " px/ft",
        )}
      </Group>
      <Group grow gap={6}>
        {num("Across", a.cx, 0.5, 1, (v) => change(a.id, { cx: v }), "′")}
        {num("Back", a.cy, 0.5, 1, (v) => change(a.id, { cy: v }), "′")}
      </Group>
      <Button size="compact-xs" variant="default" onClick={reseed}>
        Reset turn to {orientationLabel}
      </Button>
      <Text size="xs" c="dimmed">
        Crop (the photo's own edges, before it's turned)
      </Text>
      <RangeSlider
        size="xs"
        min={0}
        max={1}
        step={0.005}
        minRange={0.02}
        value={[a.cropX0, a.cropX1]}
        label={(v) => `${Math.round(v * 100)}%`}
        onChange={([x0, x1]) => onDraft(a.id, { cropX0: x0, cropX1: x1 })}
        onChangeEnd={([x0, x1]) => save(a.id, { cropX0: x0, cropX1: x1 })}
      />
      <Text size="xs" c="dimmed" mt={-4}>
        Left ↔ right
      </Text>
      <RangeSlider
        size="xs"
        min={0}
        max={1}
        step={0.005}
        minRange={0.02}
        value={[a.cropY0, a.cropY1]}
        label={(v) => `${Math.round(v * 100)}%`}
        onChange={([y0, y1]) => onDraft(a.id, { cropY0: y0, cropY1: y1 })}
        onChangeEnd={([y0, y1]) => save(a.id, { cropY0: y0, cropY1: y1 })}
      />
      <Text size="xs" c="dimmed" mt={-4}>
        Top ↕ bottom
      </Text>
      <LabelField a={a} save={(label) => save(a.id, { label })} />
    </Stack>
  );
}

function LabelField({
  a,
  save,
}: {
  a: AerialRow;
  save: (label: string) => void;
}) {
  const [value, setValue] = useState(a.label ?? "");
  return (
    <TextInput
      size="xs"
      label="Name"
      value={value}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => {
        if (value !== (a.label ?? "")) save(value);
      }}
    />
  );
}

/**
 * Feed one map click into an alignment in progress: on a photo step it's
 * turned into the photo pixel under the click (through the photo's current
 * placement); on a map step it's kept as plot feet.
 */
export function addPickPoint(
  pick: AerialPick,
  aerial: AerialRow,
  plot: Pt,
): AerialPick {
  return pickWants(pick) === "photo"
    ? { ...pick, img: [...pick.img, plotToImage(aerial, plot)] }
    : { ...pick, plot: [...pick.plot, plot] };
}
