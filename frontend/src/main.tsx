import React from "react";
import ReactDOM from "react-dom/client";
import LandingPage from "./LandingPage";
import { StartupScreen } from "./StartupScreen";

const App = React.lazy(() => import("./App"));
const isHomepage = ["/", "/index.html"].includes(window.location.pathname);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isHomepage ? (
      <LandingPage />
    ) : (
      <React.Suspense fallback={<StartupScreen />}>
        <App />
      </React.Suspense>
    )}
  </React.StrictMode>,
);
