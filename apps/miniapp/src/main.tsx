// Пустая точка входа из K-01a: экраны, MAX UI и MAX Bridge добавляют потоки из docs/roadmap.md.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <main />
    </StrictMode>,
  );
}
