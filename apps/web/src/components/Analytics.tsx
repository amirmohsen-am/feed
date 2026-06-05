"use client";

import { useEffect } from "react";
import { isSupported, getAnalytics } from "firebase/analytics";
import { app } from "@/lib/firebase";

// Initializes GA4 (via the Firebase SDK, reusing the measurementId already in
// firebase.ts) once on the client. Enhanced measurement is on for the web
// stream, so this auto-collects page_view (including SPA route changes) with no
// further instrumentation. getAnalytics() only works in the browser, so we gate
// on isSupported(). Rendered once in the root layout → covers landing + curator.
export default function Analytics() {
  useEffect(() => {
    isSupported().then((ok) => {
      if (ok) getAnalytics(app);
    });
  }, []);
  return null;
}
