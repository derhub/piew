import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import { remarkAlert } from "remark-github-blockquote-alert";
import { remarkSourceLine } from "~/lib/remark-source-line";
import { nodeText, slugify } from "~/lib/slug";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import {
  AnnotatedBlock,
  AnnotatedListItem,
  AnnotationContext,
  Thread,
  useAnnotation,
} from "./Annotation";
import type { AnnotationApi, ComposerMode, ViewerHandle } from "./Annotation";
import type { ReviewComment, ReviewEdit } from "~/lib/types";
import "katex/dist/katex.min.css";

interface MarkdownViewerProps {
  content: string;
  comments: ReviewComment[];
  edits: ReviewEdit[];
  onAddComment: (comment: {
    kind: "line_range" | "selection" | "general";
    startLine?: number;
    endLine?: number;
    quote?: string;
    feedback: string;
  }) => void;
  onAddEdit: (edit: {
    startLine: number;
    endLine: number;
    originalText: string;
    suggestedText: string;
  }) => void;
  onDeleteComment: (id: string) => void;
  onDeleteEdit: (id: string) => void;
  onUpdateComment: (id: string, feedback: string) => void;
  onUpdateEdit: (id: string, suggestedText: string) => void;
  onNavigateLink?: (href: string) => void;
  zoom?: number;
  viewerRef?: React.Ref<ViewerHandle>;
}

function Heading({ level, node, children, ...props }: any) {
  const Tag = `h${level}` as "h1";
  const line = node?.position?.start?.line;
  return (
    <AnnotatedBlock line={line} id={slugify(nodeText(children))}>
      <Tag {...props}>{children}</Tag>
    </AnnotatedBlock>
  );
}

function AnnotatedCodeBlock({
  code,
  language,
  startLine,
}: {
  code: string;
  language: string;
  startLine?: number;
}) {
  const api = useAnnotation();
  const first = startLine ?? 1;
  const last = first + code.replace(/\n$/, "").split("\n").length - 1;
  const inRange = (line?: number) => line !== undefined && line >= first && line <= last;

  // A fence owns a span of lines, so it hosts a thread for each annotated line
  // inside it. Without this the composer has nowhere to render and a comment
  // started from the code gutter, or from selecting code, vanishes.
  const threadLines = [
    ...new Set([
      ...api.comments.filter((c) => inRange(c.startLine)).map((c) => c.startLine!),
      ...api.edits.filter((e) => inRange(e.startLine)).map((e) => e.startLine),
      ...(inRange(api.openLine ?? undefined) ? [api.openLine!] : []),
    ]),
  ].sort((a, b) => a - b);

  return (
    <div data-annot data-line-start={first} className="relative">
      <CodeBlock
        code={code}
        language={language}
        startLine={startLine}
        onAddComment={(line, quote) => api.openAt(line, quote)}
      />
      {threadLines.map((line) => (
        <Thread key={line} line={line} />
      ))}
    </div>
  );
}

/** Stable across renders so react-markdown never re-parses on annotation state changes. */
const components = {
  // Fenced blocks render their own container; the typeset `pre` shell would double-box it.
  pre: ({ children }: any) => <>{children}</>,
  code({ node, className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || "");
    const lang = match ? match[1] : "";
    const codeText = String(children).replace(/\n$/, "");
    const lineStart = node?.position?.start?.line;

    if (lang === "mermaid") {
      return (
        <div data-not-typeset className="not-typeset">
          <MermaidBlock chart={codeText} />
        </div>
      );
    }

    if (className || codeText.includes("\n")) {
      return (
        <div data-not-typeset className="not-typeset">
          <AnnotatedCodeBlock code={codeText} language={lang || "text"} startLine={lineStart} />
        </div>
      );
    }

    return <code {...props}>{children}</code>;
  },
  h1: (p: any) => <Heading level={1} {...p} />,
  h2: (p: any) => <Heading level={2} {...p} />,
  h3: (p: any) => <Heading level={3} {...p} />,
  h4: (p: any) => <Heading level={4} {...p} />,
  p({ node, children, ...props }: any) {
    return (
      <AnnotatedBlock line={node?.position?.start?.line} threadAside>
        <p {...props}>{children}</p>
      </AnnotatedBlock>
    );
  },
  blockquote({ node, children, ...props }: any) {
    return (
      <AnnotatedBlock line={node?.position?.start?.line}>
        <blockquote {...props}>{children}</blockquote>
      </AnnotatedBlock>
    );
  },
  ul({ node, children, ...props }: any) {
    return (
      <AnnotatedBlock line={node?.position?.start?.line}>
        <ul {...props}>{children}</ul>
      </AnnotatedBlock>
    );
  },
  ol({ node, children, ...props }: any) {
    return (
      <AnnotatedBlock line={node?.position?.start?.line}>
        <ol {...props}>{children}</ol>
      </AnnotatedBlock>
    );
  },
  li({ node, children, ...props }: any) {
    return (
      <AnnotatedListItem line={node?.position?.start?.line} {...props}>
        {children}
      </AnnotatedListItem>
    );
  },
  table({ node, children, ...props }: any) {
    return (
      <AnnotatedBlock line={node?.position?.start?.line}>
        <table {...props}>{children}</table>
      </AnnotatedBlock>
    );
  },
  a({ href, children, ...props }: any) {
    const isExternal = /^https?:\/\//i.test(href || "");
    return (
      <LinkNode href={href} isExternal={isExternal} {...props}>
        {children}
      </LinkNode>
    );
  },
};

const NavigateContext = React.createContext<((href: string) => void) | undefined>(undefined);

function LinkNode({ href, isExternal, children, ...props }: any) {
  const navigate = React.useContext(NavigateContext);
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!isExternal && navigate && href) {
          e.preventDefault();
          navigate(href);
        }
      }}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noreferrer" : undefined}
      {...props}
    >
      {children}
    </a>
  );
}

const remarkPlugins = [remarkGfm, remarkFrontmatter, remarkMath, remarkAlert, remarkSourceLine];
const rehypePlugins = [rehypeRaw, rehypeKatex];

export function MarkdownViewer({
  content,
  comments,
  edits,
  onAddComment,
  onAddEdit,
  onDeleteComment,
  onDeleteEdit,
  onUpdateComment,
  onUpdateEdit,
  onNavigateLink,
  zoom = 1,
  viewerRef,
}: MarkdownViewerProps) {
  const [open, setOpen] = React.useState<{
    line: number;
    quote?: string;
    mode?: ComposerMode;
  } | null>(null);

  React.useImperativeHandle(
    viewerRef,
    () => ({
      openAt: (line, quote, mode) => setOpen({ line, quote, mode }),
      close: () => setOpen(null),
    }),
    []
  );

  const api: AnnotationApi = React.useMemo(
    () => ({
      comments,
      edits,
      openLine: open?.line ?? null,
      pendingQuote: open?.quote,
      pendingMode: open?.mode,
      openAt: (line, quote, mode) => setOpen({ line, quote, mode }),
      close: () => setOpen(null),
      addComment: ({ line, quote, feedback }) =>
        onAddComment({
          kind: quote ? "selection" : "line_range",
          startLine: line,
          endLine: line,
          quote,
          feedback,
        }),
      addEdit: ({ line, originalText, suggestedText }) =>
        onAddEdit({ startLine: line, endLine: line, originalText, suggestedText }),
      deleteComment: onDeleteComment,
      deleteEdit: onDeleteEdit,
      updateComment: onUpdateComment,
      updateEdit: onUpdateEdit,
    }),
    [
      comments,
      edits,
      open,
      onAddComment,
      onAddEdit,
      onDeleteComment,
      onDeleteEdit,
      onUpdateComment,
      onUpdateEdit,
    ]
  );

  // Parsing + highlighting is expensive; keep it keyed to the document text alone.
  const document_ = React.useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    ),
    [content]
  );

  const handleSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const quote = selection.toString().trim();
    if (!quote) return;

    const el =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;

    // Must resolve to a block that actually hosts a thread — every element carries
    // data-line-start, and a line nothing owns would drop the composer silently.
    const host = el?.closest<HTMLElement>("[data-annot][data-line-start]");
    if (!host) return;

    setOpen({ line: Number(host.dataset.lineStart), quote });
  };

  return (
    <NavigateContext.Provider value={onNavigateLink}>
      <AnnotationContext.Provider value={api}>
        <div
          className="doc-column mx-auto w-full max-w-[52rem] pt-10 pb-28"
          onMouseUp={handleSelection}
          // `zoom` scales rem-based children too, which a font-size change would not.
          // Widths resolve in the zoomed coordinate space already, so the column grows
          // with zoom; only the gutter is divided back out so it stays put.
          style={{ zoom, paddingInline: `calc(var(--doc-pad) / ${zoom})` }}
        >
          <article className="typeset typeset-docs w-full max-w-none">{document_}</article>
        </div>
      </AnnotationContext.Provider>
    </NavigateContext.Provider>
  );
}
