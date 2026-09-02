import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared 1200x630 social card: a CRT test-card riff on the player chrome.
 * Same palette + type as globals.css / stream-client.tsx. Used by the site
 * card (app/opengraph-image.tsx) and per-clip cards (app/c/[id]). */

export const OG_SIZE = { width: 1200, height: 630 };

const C = {
  void: "#0d0b0e",
  teal: "#2ec4b6",
  orange: "#ff6b35",
  mustard: "#f5b700",
  cream: "#f4ecd6",
  danger: "#e63946",
};

const asset = (rel: string) => readFile(join(process.cwd(), rel));

export interface OgCardProps {
  /** Small teal line above the headline, e.g. "NOW SHOWING ON INFINITE". */
  kicker?: string;
  /** Big mustard Bungee headline with the red hard shadow. */
  headline: string;
  headlineSize: number;
  /** Teal Bungee line under the headline. */
  tagline?: string;
  /** Cream body copy. */
  blurb: string;
}

/** Pick a headline size that keeps arbitrary clip titles inside the card. */
export function headlineSizeFor(text: string): number {
  const n = text.length;
  if (n <= 12) return 120;
  if (n <= 20) return 96;
  if (n <= 32) return 72;
  if (n <= 48) return 56;
  return 44;
}

export async function renderOgCard(props: OgCardProps): Promise<ImageResponse> {
  const [bungee, grotesk, atlPng, voltageSvg] = await Promise.all([
    asset("app/fonts/Bungee-Regular.ttf"),
    asset("app/fonts/SpaceGrotesk-Bold.ttf"),
    asset("public/atlbitlab-white.png"),
    asset("public/voltage-white.svg"),
  ]);
  const atlSrc = `data:image/png;base64,${atlPng.toString("base64")}`;
  const voltageSrc = `data:image/svg+xml;base64,${voltageSvg.toString("base64")}`;
  const bars = [C.teal, C.orange, C.mustard, C.cream, C.danger];
  const shadow = Math.max(4, Math.round(props.headlineSize / 23));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          background: C.void,
          color: C.cream,
          fontFamily: "Space Grotesk",
          overflow: "hidden",
        }}
      >
        {/* tube glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "radial-gradient(circle at 30% 45%, rgba(46,196,182,0.22) 0%, rgba(46,196,182,0) 55%)",
          }}
        />

        {/* the "∞" — two rings, drawn not typed */}
        <div
          style={{
            position: "absolute",
            right: 40,
            top: 110,
            width: 300,
            height: 300,
            borderRadius: 150,
            border: `26px solid ${C.teal}`,
            opacity: 0.18,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 250,
            top: 110,
            width: 300,
            height: 300,
            borderRadius: 150,
            border: `26px solid ${C.orange}`,
            opacity: 0.18,
          }}
        />

        {/* top chrome: ON AIR + colour bars */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "44px 60px 0",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              background: C.danger,
              color: C.cream,
              padding: "10px 22px",
              fontFamily: "Bungee",
              fontSize: 26,
              letterSpacing: 3,
            }}
          >
            <div style={{ width: 16, height: 16, borderRadius: 8, background: C.cream }} />
            ON AIR
          </div>
          <div style={{ display: "flex" }}>
            {bars.map((b) => (
              <div key={b} style={{ width: 40, height: 44, background: b }} />
            ))}
          </div>
        </div>

        {/* title block */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "24px 60px 0",
            flexGrow: 1,
            maxWidth: 1000,
          }}
        >
          {props.kicker && (
            <div
              style={{
                fontFamily: "Bungee",
                fontSize: 24,
                letterSpacing: 6,
                color: C.teal,
                marginBottom: 14,
              }}
            >
              {props.kicker}
            </div>
          )}
          <div
            style={{
              fontFamily: "Bungee",
              fontSize: props.headlineSize,
              lineHeight: 1.05,
              color: C.mustard,
              textShadow: `${shadow}px ${shadow}px 0 ${C.danger}`,
              marginLeft: -4,
            }}
          >
            {props.headline}
          </div>
          {props.tagline && (
            <div
              style={{
                fontFamily: "Bungee",
                fontSize: 30,
                letterSpacing: 8,
                color: C.teal,
                marginTop: 18,
              }}
            >
              {props.tagline}
            </div>
          )}
          <div
            style={{
              fontSize: 30,
              lineHeight: 1.3,
              color: C.cream,
              marginTop: 18,
              maxWidth: 820,
            }}
          >
            {props.blurb}
          </div>
        </div>

        {/* lower third */}
        <div style={{ display: "flex", margin: "22px 60px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: C.orange,
              color: C.void,
              fontFamily: "Bungee",
              fontSize: 22,
              letterSpacing: 4,
              padding: "12px 22px",
            }}
          >
            TUNE IN
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: C.cream,
              color: C.void,
              fontFamily: "Bungee",
              fontSize: 30,
              padding: "12px 26px",
            }}
          >
            infinite.atlbitlab.com
          </div>
        </div>

        {/* footer credits */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "30px 60px 40px",
            fontSize: 20,
            letterSpacing: 5,
            color: C.cream,
            opacity: 0.85,
          }}
        >
          <div style={{ display: "flex" }}>AN</div>
          <img src={atlSrc} width={142} height={52} alt="" />
          <div style={{ display: "flex" }}>PROJECT</div>
          <div style={{ width: 2, height: 36, background: C.cream, opacity: 0.4 }} />
          <div style={{ display: "flex" }}>POWERED BY</div>
          <img src={voltageSrc} width={218} height={36} alt="" />
        </div>

        {/* CRT scanlines over everything */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.22) 3px, rgba(0,0,0,0) 4px)",
            backgroundSize: "100% 4px",
            backgroundRepeat: "repeat",
          }}
        />
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Bungee", data: bungee, weight: 400, style: "normal" },
        { name: "Space Grotesk", data: grotesk, weight: 700, style: "normal" },
      ],
    },
  );
}
