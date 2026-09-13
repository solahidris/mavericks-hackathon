"use client";
import dynamic from "next/dynamic";
import Providers from "./providers";
const Marketplace = dynamic(() => import("./marketplace"), {
  ssr: false,
  loading: () => (
    <div className="boot">
      Starting Relay<span className="loading-dots">…</span>
    </div>
  ),
});
export default function Page() {
  return (
    <Providers>
      <Marketplace />
    </Providers>
  );
}
