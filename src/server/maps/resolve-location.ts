const OLC_ALPHABET = "23456789CFGHJMPQRVWX";
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125] as const;

export type ResolvedLocation = {
  latitude: number;
  longitude: number;
  formattedAddress?: string | null;
};

function validCoords(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

export function parseCoordinates(raw: string): ResolvedLocation | null {
  const patterns = [
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
    /(?:^|[?&](?:q|query|ll)=)(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)(?:&|$)/,
    /(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (validCoords(latitude, longitude)) return { latitude, longitude };
  }
  return null;
}

function plusCodeToken(raw: string): string | null {
  const decoded = decodeURIComponent(raw).toUpperCase();
  const match = decoded.match(
    /(?:^|[^23456789CFGHJMPQRVWX])([23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,7})(?:$|[^23456789CFGHJMPQRVWX])/
  );
  return match?.[1] ?? null;
}

export function decodeFullPlusCode(raw: string): ResolvedLocation | null {
  const token = plusCodeToken(raw);
  if (!token) return null;

  const clean = token.replace("+", "");
  if (clean.length < 10) return null;

  let latLo = -90;
  let lngLo = -180;
  let latResolution = PAIR_RESOLUTIONS[PAIR_RESOLUTIONS.length - 1];
  let lngResolution = latResolution;

  const pairLength = Math.min(clean.length, 10);
  for (let i = 0; i < pairLength; i += 2) {
    const latIndex = OLC_ALPHABET.indexOf(clean[i] ?? "");
    const lngIndex = OLC_ALPHABET.indexOf(clean[i + 1] ?? "");
    const resolution = PAIR_RESOLUTIONS[i / 2];
    if (latIndex < 0 || lngIndex < 0 || resolution === undefined) return null;
    latLo += latIndex * resolution;
    lngLo += lngIndex * resolution;
    latResolution = resolution;
    lngResolution = resolution;
  }

  let latHi = latLo + latResolution;
  let lngHi = lngLo + lngResolution;

  if (clean.length > 10) {
    let gridLatResolution = latResolution;
    let gridLngResolution = lngResolution;
    for (let i = 10; i < clean.length; i += 1) {
      const index = OLC_ALPHABET.indexOf(clean[i] ?? "");
      if (index < 0) return null;
      gridLatResolution /= 5;
      gridLngResolution /= 4;
      const row = Math.floor(index / 4);
      const col = index % 4;
      latLo += row * gridLatResolution;
      lngLo += col * gridLngResolution;
      latHi = latLo + gridLatResolution;
      lngHi = lngLo + gridLngResolution;
    }
  }

  const latitude = (latLo + latHi) / 2;
  const longitude = (lngLo + lngHi) / 2;
  return validCoords(latitude, longitude) ? { latitude, longitude } : null;
}

function isAllowedGoogleMapsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "maps.app.goo.gl" ||
    host === "goo.gl" ||
    host === "google.com" ||
    host === "www.google.com" ||
    host === "maps.google.com" ||
    host.endsWith(".google.com") ||
    host.endsWith(".google.com.mx")
  );
}

export function parseGoogleMapsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isAllowedGoogleMapsHost(url.hostname)) return null;
  return url;
}

export function resolveFromText(raw: string): ResolvedLocation | null {
  return parseCoordinates(raw) ?? decodeFullPlusCode(raw);
}

export async function resolveGoogleMapsShareLink(
  raw: string,
  fetchImpl: typeof fetch = fetch
): Promise<ResolvedLocation | null> {
  let current = parseGoogleMapsUrl(raw);
  if (!current) return null;

  for (let hop = 0; hop < 6; hop += 1) {
    const direct = resolveFromText(current.toString());
    if (direct) return direct;

    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; ConectaDigitalCRM/1.0)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    const location = response.headers.get("location");
    if (!location) {
      const finalDirect = resolveFromText(response.url || current.toString());
      return finalDirect;
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.protocol !== "https:" || !isAllowedGoogleMapsHost(next.hostname)) {
      return null;
    }
    current = next;
  }

  return null;
}
