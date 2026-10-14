import type { Metadata } from "next";
import MeClient from "./me-client";

export const metadata: Metadata = {
  title: "My videos — INFINITE",
  robots: { index: false },
};

export default function MePage() {
  return <MeClient />;
}
