import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const ALLOWED_PACKAGES = new Set([
  "@derhub/piew/tool",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
]);

type Source = string | { encoding: "base64"; content: string };
type Input = { entry: string; files: Record<string, Source> };

const RESOLVED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".json",
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
];

function diagnostic(message: string): string {
  return Buffer.from(message).subarray(0, MAX_DIAGNOSTIC_BYTES).toString();
}

function filePath(value: string): string | undefined {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return value;
}

function validate(input: Input): string | undefined {
  if (!input || typeof input !== "object" || !input.files || typeof input.files !== "object") {
    return "Invalid compiler input";
  }
  if (!filePath(input.entry) || typeof input.files[input.entry] !== "string") {
    return "Invalid compiler entry";
  }

  let bytes = 0;
  for (const [name, source] of Object.entries(input.files)) {
    if (
      !filePath(name) ||
      /(?:^|\/)(?:package|tsconfig)\.json$|(?:^|\/)bunfig\.toml$/.test(name) ||
      (typeof source !== "string" &&
        (!source || source.encoding !== "base64" || typeof source.content !== "string"))
    ) {
      return `Invalid source file: ${name}`;
    }
    const content =
      typeof source === "string" ? Buffer.from(source) : Buffer.from(source.content, "base64");
    const size = content.byteLength;
    if (size > MAX_FILE_BYTES) return `Source file exceeds 256 KiB: ${name}`;
    bytes += size;
    if (bytes > MAX_INPUT_BYTES) return "Compiler input exceeds 1 MiB";
    if (
      (typeof source === "string" && /\b(?:import|require)\s*\(/.test(source)) ||
      (typeof source === "string" &&
        /\b(?:process\.env|Bun\.env|import\.meta\.env)\b/.test(source)) ||
      (typeof source === "string" && /\b(?:macro:|with\s*\{\s*type\s*:\s*["']macro)/.test(source))
    ) {
      return `Forbidden source capability: ${name}`;
    }
    if (typeof source !== "string") continue;
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (
        specifier.startsWith("/") ||
        specifier.includes("\\") ||
        /^(?:[a-z][a-z0-9+.-]*:|node:|bun:)/i.test(specifier)
      ) {
        return `Forbidden import: ${specifier}`;
      }
      if (!specifier.startsWith(".") && !ALLOWED_PACKAGES.has(specifier)) {
        return `Forbidden import: ${specifier}`;
      }
    }
  }
}

function toolApi(): string {
  return "export function definePiewTool(definition) { return definition; }";
}

function resolveVirtualFile(
  files: Record<string, string | Uint8Array>,
  importer: string,
  specifier: string
): string | undefined {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!resolved.startsWith("/piew-tool/")) return;
  const candidates = path.posix.extname(resolved)
    ? [resolved]
    : [
        resolved,
        ...RESOLVED_EXTENSIONS.map((extension) => `${resolved}${extension}`),
        ...RESOLVED_EXTENSIONS.map((extension) => `${resolved}/index${extension}`),
      ];
  return candidates.find((candidate) => Object.hasOwn(files, candidate));
}

function toolEntry(entry: string): string {
  return `import React from "react";
import { createRoot } from "react-dom/client";
import definition from ${JSON.stringify(`./${entry}`)};

const rootElement = document.getElementById("root");
const baseline = document.createElement("style");
baseline.textContent = \
  ':root{color-scheme:light;--piew-background:#fff;--piew-foreground:#0a0a0a;--piew-muted:#f5f5f5;--piew-border:#e5e5e5}:root[data-piew-theme="dark"]{color-scheme:dark;--piew-background:#0a0a0a;--piew-foreground:#fafafa;--piew-muted:#1f1f1f;--piew-border:#404040}*{box-sizing:border-box}html,body,#root{min-height:100%;margin:0}body{background:var(--piew-background);color:var(--piew-foreground);font:14px/20px system-ui,sans-serif}button,input,textarea,select{font:inherit;color:inherit}button{touch-action:manipulation}button:focus-visible{outline:2px solid var(--piew-foreground);outline-offset:2px}';
document.head.append(baseline);

class ToolBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error.message : "Tool failed to render" };
  }
  render() {
    return this.state.error
      ? React.createElement("p", { role: "alert" }, this.state.error)
      : this.props.children;
  }
}

const root = createRoot(rootElement);
const Component = definition.component;
let channel;
let request;
let observer;

function validTheme(theme) {
  return theme === "light" || theme === "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.piewTheme = theme;
}

function render() {
  const submit = (value) => window.parent.postMessage({
    type: "piew:submit",
    channel,
    value,
  }, "*");
  root.render(React.createElement(
    ToolBoundary,
    null,
    React.createElement(Component, {
      prompt: request.prompt,
      data: request.data,
      theme: request.theme,
      submit,
    }),
  ));
}

function reportResize(entries) {
  const observed = entries[0] && entries[0].contentRect.height;
  const height = Math.max(rootElement.scrollHeight, observed || 0);
  if (Number.isFinite(height)) {
    window.parent.postMessage({ type: "piew:resize", channel, height }, "*");
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window.parent || !message) return;
  if (
    typeof channel === "string" &&
    message.type === "piew:theme" &&
    message.channel === channel &&
    validTheme(message.theme)
  ) {
    request = { ...request, theme: message.theme };
    applyTheme(request.theme);
    render();
    return;
  }
  if (
    channel ||
    message.type !== "piew:init" ||
    typeof message.channel !== "string" ||
    !message.channel ||
    typeof message.prompt !== "string" ||
    !validTheme(message.theme)
  ) return;
  channel = message.channel;
  request = { prompt: message.prompt, data: message.data, theme: message.theme };
  applyTheme(request.theme);
  render();
  observer = new ResizeObserver(reportResize);
  observer.observe(rootElement);
  reportResize([]);
});
window.parent.postMessage({ type: "piew:ready" }, "*");`;
}

async function compile(input: Input) {
  const rejected = validate(input);
  if (rejected) return { ok: false as const, diagnostic: rejected };

  const files = Object.fromEntries(
    Object.entries(input.files).map(([name, source]) => {
      const content =
        typeof source === "string"
          ? source.replace(
              /(\b(?:from|import)\s*)(["'])@derhub\/piew\/tool\2/g,
              "$1$2./__piew_tool_api__.js$2"
            )
          : new Uint8Array(Buffer.from(source.content, "base64"));
      return [`/piew-tool/${name}`, content];
    })
  );
  files["/piew-tool/__piew_tool_api__.js"] = toolApi();
  files["/piew-tool/__piew_entry__.tsx"] = toolEntry(input.entry);
  const build = await Bun.build({
    entrypoints: ["/piew-tool/__piew_entry__.tsx"],
    files,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: true,
    sourcemap: "none",
    tsconfig: fileURLToPath(new URL("./tool-tsconfig.json", import.meta.url)),
    env: "disable",
    allowUnresolved: [],
    loader: {
      ".avif": "dataurl",
      ".gif": "dataurl",
      ".jpeg": "dataurl",
      ".jpg": "dataurl",
      ".png": "dataurl",
      ".svg": "dataurl",
      ".webp": "dataurl",
      ".ico": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".ttf": "dataurl",
    },
    plugins: [
      {
        name: "piew-tool-files",
        setup(builder) {
          builder.onResolve(
            {
              filter: /^(?:react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom\/client)$/,
            },
            (args) => ({
              path: fileURLToPath(import.meta.resolve(args.path)),
              namespace: "file",
            })
          );
          const resolveToolImport = (args: { path: string; importer: string }) => {
            if (!args.path.startsWith(".")) {
              return { errors: [{ text: `Forbidden import: ${args.path}` }] };
            }
            const resolved = resolveVirtualFile(files, args.importer, args.path);
            if (!resolved) {
              return {
                errors: [{ text: `Unresolved or escaped tool import: ${args.path}` }],
              };
            }
            return { path: resolved, namespace: "piew-tool" };
          };
          builder.onResolve({ filter: /^\./, namespace: "file" }, (args) =>
            args.importer.startsWith("/piew-tool/") ? resolveToolImport(args) : undefined
          );
          builder.onResolve({ filter: /.*/, namespace: "piew-tool" }, resolveToolImport);
          builder.onLoad({ filter: /.*/, namespace: "piew-tool" }, (args) => ({
            contents: files[args.path],
          }));
        },
      },
    ],
  });

  if (!build.success) {
    return {
      ok: false as const,
      diagnostic: diagnostic(build.logs.map((log) => JSON.stringify(log)).join("\n")),
    };
  }

  const outputs = await Promise.all(
    build.outputs.map(async (output) => ({
      path: output.path.endsWith(".js")
        ? "tool.js"
        : output.path.endsWith(".css")
          ? "tool.css"
          : output.path,
      content: new Uint8Array(await output.arrayBuffer()),
    }))
  );
  if (!outputs.some((file) => file.path === "tool.js")) {
    return {
      ok: false as const,
      diagnostic: "Compiler produced no JavaScript artifact",
    };
  }
  const bytes = outputs.reduce((total, file) => total + file.content.byteLength, 0);
  if (bytes > MAX_ARTIFACT_BYTES) {
    return {
      ok: false as const,
      diagnostic: "Compiler artifact exceeds 2 MiB",
    };
  }
  return {
    ok: true as const,
    files: outputs.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content).toString("base64"),
    })),
  };
}

try {
  const input = JSON.parse(await Bun.stdin.text()) as Input;
  process.stdout.write(JSON.stringify(await compile(input)));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      diagnostic: diagnostic(error instanceof Error ? error.message : String(error)),
    })
  );
}
