import React from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { applyTheme, getThemePreference } from "~/hooks/use-theme";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  React.useEffect(() => {
    applyTheme(getThemePreference());
  }, []);

  // A definite height, not a minimum: the resize group sets inline `height: 100%`,
  // which collapses to content height against a parent that only has min-height.
  return (
    <div className="bg-background text-foreground selection:bg-primary/20 selection:text-foreground h-dvh font-sans antialiased">
      <Outlet />
    </div>
  );
}
