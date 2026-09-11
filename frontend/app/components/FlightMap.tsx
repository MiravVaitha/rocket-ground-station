"use client";

import {
  type GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
} from "maplibre-gl";
import { useEffect, useReducer, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * The GPS track, the pad, and the last known position of the payload.
 *
 * Driven through the MapLibre API directly rather than through a React
 * wrapper. `react-map-gl` 8.1.3 hands MapLibre 6.x a container it rejects
 * ("Invalid type: 'container' must be a String or HTMLElement"), which aborts
 * initialisation after the style has parsed but before any source cache is
 * built - so the map paints its background colour and never requests a single
 * tile. That reproduces in dev and in a production build, on both maplibre-gl
 * 6.4 and 6.9. See NOTES.md 2026-09-10.
 *
 * Secondary surface by design: during ascent a rocket's ground track is a
 * near-vertical line and says almost nothing in two dimensions. It earns its
 * space on descent, and again in the recovery view.
 */

// MapLibre's own `defaultWorkerUrl()` bails with an empty string unless
// `import.meta.url` is an http(s) URL, which it is not for a Turbopack chunk -
// so it ends up calling `new Worker("")`, which fails silently. Pointing it at
// maplibre's stock worker served from /public fixes the URL. The two .mjs
// files there are copied from node_modules/maplibre-gl/dist and must be
// re-copied on any upgrade. See NOTES.md 2026-09-10.
setWorkerUrl("/maplibre-gl-worker.mjs");

/**
 * Satellite imagery, as a raster source declared inline.
 *
 * Raster tiles are decoded on the main thread, unlike vector tiles which are
 * parsed in the Web Worker - so this sidesteps the worker path that never
 * completes under Turbopack (NOTES.md 2026-09-10). Declaring the style inline
 * rather than fetching a style JSON removes another moving part.
 *
 * Imagery rather than a street map because of what the map is actually for
 * here: walking to a landing site in open ground, where field boundaries and
 * tree lines are the landmarks and street names are not.
 *
 * Esri tiles are addressed {z}/{y}/{x} - row before column - which is the
 * reverse of the usual slippy-map convention.
 */
const IMAGERY_STYLE = {
  version: 8 as const,
  sources: {
    imagery: {
      type: "raster" as const,
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [{ id: "imagery", type: "raster" as const, source: "imagery" }],
};

/** Somewhere to point the camera before the first fix arrives. */
const FALLBACK: [number, number] = [-1.8, 51.2];

export type MapPoint = { lat_deg: number; lon_deg: number };

type Props = {
  /** [lon, lat] pairs, oldest first. */
  track: [number, number][];
  pad: MapPoint | null;
  /** Last known fix. Not necessarily the newest packet. */
  position: MapPoint | null;
  /** Greys the payload marker when the fix is old. */
  stale?: boolean;
  /**
   * "recovery" frames both the pad and the last fix and draws the bearing
   * between them. "flight" leaves the camera alone and hides the bearing, so
   * the track is not cluttered while the flight is still happening.
   */
  focus?: "flight" | "recovery";
};

function lineFeature(coords: [number, number][]) {
  return {
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: coords },
    properties: {},
  };
}

function markerEl(svg: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = svg;
  return el;
}

const PAD_SVG = `<svg width="18" height="18" viewBox="0 0 18 18">
  <rect x="3" y="3" width="12" height="12" fill="none" stroke="#c3c2b7" stroke-width="2"/>
  <circle cx="9" cy="9" r="1.5" fill="#c3c2b7"/></svg>`;

// 2px surface ring so the marker stays legible where it sits on the track line.
const payloadSvg = (stale: boolean) => `<svg width="18" height="18" viewBox="0 0 18 18">
  <circle cx="9" cy="9" r="5.5" fill="${stale ? "#898781" : "#d95926"}"
          stroke="#1a1a19" stroke-width="2"/></svg>`;

export default function FlightMap({
  track,
  pad,
  position,
  stale,
  focus = "flight",
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const padMarker = useRef<Marker | null>(null);
  const posMarker = useRef<Marker | null>(null);
  const centred = useRef(false);
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: IMAGERY_STYLE,
      center: FALLBACK,
      zoom: 14,
    });
    mapRef.current = map;

    map.on("load", () => {
      // Added empty; the track effect below fills it on the render that
      // `force()` triggers, so no prop needs capturing here.
      map.addSource("track", { type: "geojson", data: lineFeature([]) });
      map.addLayer({
        id: "track-line",
        type: "line",
        source: "track",
        paint: { "line-color": "#3987e5", "line-width": 3 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addSource("bearing", { type: "geojson", data: lineFeature([]) });
      map.addLayer({
        id: "bearing-line",
        type: "line",
        source: "bearing",
        // Dashed because it is a heading to walk, not a path anything flew.
        paint: {
          "line-color": "#d95926",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      readyRef.current = true;
      // Re-run the effects below so anything that arrived during style load
      // gets applied to the map that now exists.
      force();
    });

    return () => {
      readyRef.current = false;
      padMarker.current?.remove();
      posMarker.current?.remove();
      padMarker.current = null;
      posMarker.current = null;
      centred.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Track geometry, and the pad-to-fix bearing line in recovery.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource("track") as GeoJSONSource | undefined)?.setData(
      lineFeature(track)
    );
    const bearing =
      focus === "recovery" && pad && position
        ? lineFeature([
            [pad.lon_deg, pad.lat_deg],
            [position.lon_deg, position.lat_deg],
          ])
        : lineFeature([]);
    (map.getSource("bearing") as GeoJSONSource | undefined)?.setData(bearing);
  });

  // Recovery framing: fit both ends in view. Only while that view is open, so
  // switching back to the flight does not yank the camera around.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || focus !== "recovery" || !pad || !position)
      return;
    map.fitBounds(
      [
        [
          Math.min(pad.lon_deg, position.lon_deg),
          Math.min(pad.lat_deg, position.lat_deg),
        ],
        [
          Math.max(pad.lon_deg, position.lon_deg),
          Math.max(pad.lat_deg, position.lat_deg),
        ],
      ],
      // Capped: Esri imagery upsamples past 16 in open country, and a
      // blurred basemap is worse than a slightly wider one.
      { padding: 70, maxZoom: 16, duration: 0 }
    );
  }, [focus, pad, position]);

  // Pad marker, plus the one camera move: centre on the pad the first time it
  // is known. After that the view belongs to whoever is driving.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    // Removed, not left where it was: seeking a replay back to before the pad
    // was known must not show a pad from later in the flight.
    if (!pad) {
      padMarker.current?.remove();
      padMarker.current = null;
      return;
    }
    if (!padMarker.current) {
      padMarker.current = new Marker({ element: markerEl(PAD_SVG) })
        .setLngLat([pad.lon_deg, pad.lat_deg])
        .addTo(map);
    } else {
      padMarker.current.setLngLat([pad.lon_deg, pad.lat_deg]);
    }
    if (!centred.current) {
      map.jumpTo({ center: [pad.lon_deg, pad.lat_deg], zoom: 14 });
      centred.current = true;
    }
  }, [pad]);

  // Payload marker. Removed when there is no fix, for the same reason as the
  // pad marker above.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (!position) {
      posMarker.current?.remove();
      posMarker.current = null;
      return;
    }
    if (!posMarker.current) {
      posMarker.current = new Marker({
        element: markerEl(payloadSvg(!!stale)),
      })
        .setLngLat([position.lon_deg, position.lat_deg])
        .addTo(map);
    } else {
      posMarker.current.setLngLat([position.lon_deg, position.lat_deg]);
      posMarker.current.getElement().innerHTML = payloadSvg(!!stale);
    }
  }, [position, stale]);

  return <div ref={containerRef} className="h-full w-full" />;
}
