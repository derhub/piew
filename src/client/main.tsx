import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "~/components/ui/tooltip";
import { router } from "./router";
import "./styles.css";

window.addEventListener("error", (e) => {
  console.error("Global client error:", e.error || e.message);
});

const rootElement = document.getElementById("root");
if (rootElement) {
  try {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </React.StrictMode>
    );
  } catch (err) {
    console.error("Root render error:", err);
  }
}
