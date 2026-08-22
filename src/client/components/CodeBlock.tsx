import React from "react";
import { bundledLanguages, codeToHtml } from "shiki";
import { Copy, Check, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

interface CodeBlockProps {
  code: string;
  language?: string;
  startLine?: number;
  onAddComment?: (line: number, quote: string) => void;
}

export function CodeBlock({
  code,
  language = "text",
  startLine = 1,
  onAddComment,
}: CodeBlockProps) {
  const [html, setHtml] = React.useState<string>("");
  const [copied, setCopied] = React.useState(false);
  const cleanCode = code.replace(/\n$/, "");

  React.useEffect(() => {
    let active = true;
    const lang = language.toLowerCase();
    const safeLang = lang in bundledLanguages ? lang : "text";

    codeToHtml(cleanCode, {
      lang: safeLang,
      // Markdown keeps its own highlighter: the diff theme picker offers themes
      // that @pierre/diffs registers itself and shiki cannot resolve.
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
      .then((res) => {
        if (active) setHtml(res);
      })
      .catch(() => {
        if (active) setHtml("");
      });

    return () => {
      active = false;
    };
  }, [cleanCode, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = cleanCode.split("\n");

  return (
    <div className="group relative my-4 overflow-hidden rounded-lg border bg-muted font-mono text-sm">
      <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1.5 text-xs">
        <span className="font-medium uppercase">{language || "code"}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            }
          />
          <TooltipContent side="left">{copied ? "Copied!" : "Copy code"}</TooltipContent>
        </Tooltip>
      </div>

      <div className="overflow-x-auto p-3">
        {html ? (
          <div
            className="[&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:!font-mono text-xs leading-5"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="flex flex-col text-xs leading-5">
            {lines.map((line, idx) => {
              const lineNum = startLine + idx;
              const isDiffAdd = line.startsWith("+");
              const isDiffDel = line.startsWith("-");

              return (
                <div
                  key={idx}
                  className={`group/line relative flex items-center gap-3 px-2 py-0.5 rounded ${
                    isDiffAdd
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : isDiffDel
                        ? "bg-red-500/10 text-red-700 dark:text-red-300"
                        : ""
                  }`}
                >
                  <span className="w-8 select-none text-right text-muted-foreground/60 text-[11px] shrink-0">
                    {lineNum}
                  </span>
                  {onAddComment && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onAddComment(lineNum, line)}
                      className="opacity-0 group-hover/line:opacity-100 size-4 p-0 text-muted-foreground hover:text-foreground shrink-0"
                    >
                      <Plus className="size-3" />
                    </Button>
                  )}
                  <pre className="flex-1 overflow-x-auto bg-transparent p-0 m-0 font-mono">
                    {line || " "}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
