import { useEffect, useRef, useState } from "react";
import videoWebm from "./assets/landing/hero-background.webm";
import videoMp4 from "./assets/landing/hero-background.mp4";
import poster from "./assets/landing/hero-poster.jpg";
export function DaylightBackground() {
  const video = useRef<HTMLVideoElement>(null);
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    video.current?.load();
    if (!reduceMotion) void video.current?.play().catch(() => {});
  }, [reduceMotion]);
  return (
    <video
      className="daylight-background"
      ref={video}
      autoPlay={!reduceMotion}
      muted
      loop
      playsInline
      preload={reduceMotion ? "none" : "auto"}
      poster={poster}
      aria-hidden="true"
    >
      {!reduceMotion && (
        <>
          <source src={videoWebm} type="video/webm" />
          <source src={videoMp4} type="video/mp4" />
        </>
      )}
    </video>
  );
}
