import "@maxhub/max-ui/dist/styles.css";
import "./core/shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, getBridge, readLaunchContext, SCREENS } from "./core";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppShell launch={readLaunchContext(getBridge())} screens={SCREENS} />
    </StrictMode>,
  );
}
