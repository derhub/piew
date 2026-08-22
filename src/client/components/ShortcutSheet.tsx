const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "Cmd" : "Ctrl";

const KEYS: Array<[string, string]> = [
  ["j / k", "Next / previous annotation"],
  ["] / [", "Next / previous file"],
  ["c", "Comment on the block in view"],
  ["e", "Suggest an edit on the block in view"],
  ["/", "Find in this page"],
  ["f", "Show or hide the feedback panel"],
  ["r", "Answer the agent's open question"],
  [`${MOD} + Enter`, "Send the batch to the agent"],
  ["Esc", "Close the composer or this sheet"],
  ["?", "Show this sheet"],
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-popover text-popover-foreground w-full max-w-sm rounded-xl border p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">Keyboard shortcuts</h2>
        <dl className="flex flex-col gap-1.5 text-sm">
          {KEYS.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-xs">{key}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
