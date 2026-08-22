import React from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { FileText, GitCompare, Terminal } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "~/components/ui/card";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexComponent,
});

interface SessionRow {
  id: string;
  kind: "markdown" | "diff" | "file";
  files: string[];
  lastSeen: number;
}

function IndexComponent() {
  const [sessions, setSessions] = React.useState<SessionRow[] | null>(null);

  React.useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      // Reopening the same files starts a new session; only the newest is worth a row.
      .then((body) => {
        const seen = new Set<string>();
        setSessions(
          (body.sessions ?? []).filter((session: SessionRow) => {
            const key = session.files.join("|");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
        );
      })
      .catch(() => setSessions([]));
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-6">
      <Card className="bg-card/60 border-border w-full p-6 shadow-sm">
        <CardHeader className="mb-4 p-0 text-center">
          <div className="bg-primary/10 text-primary mx-auto mb-3 flex size-12 items-center justify-center rounded-xl">
            <FileText className="size-6" />
          </div>
          <CardTitle className="text-lg font-bold">Ready for Review</CardTitle>
          <CardDescription className="text-muted-foreground mt-1 text-xs">
            Open a document, a source file, or a diff from your terminal.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 p-0">
          <div className="bg-muted/70 border-border rounded-lg border p-3 text-left font-mono text-xs">
            <div className="text-muted-foreground/60 mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase">
              <Terminal className="size-3" />
              <span>Terminal</span>
            </div>
            <code className="text-foreground block">$ piew path/to/spec.md</code>
            <code className="text-foreground block">$ piew diff main..feat</code>
          </div>

          {sessions === null ? null : sessions.length === 0 ? (
            <p className="text-muted-foreground border-border border-t pt-3 text-xs">
              No review open right now.
            </p>
          ) : (
            <div className="border-border flex flex-col gap-1 border-t pt-3">
              <p className="text-foreground mb-1 text-xs font-semibold">Open reviews</p>
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  to="/review/$sessionId"
                  params={{ sessionId: session.id }}
                  className="hover:bg-muted/70 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  {session.kind === "diff" ? (
                    <GitCompare className="size-3.5 shrink-0" />
                  ) : (
                    <FileText className="size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{session.files.join(", ")}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {session.files.length} file{session.files.length === 1 ? "" : "s"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
