import type { AutoPaperBySleeve, SleeveId } from "../../shared/types";
import { AUTO_SLEEVE_CHIPS } from "./essentials";

export function AutoPaperChips({
  flags,
  variant,
  onToggle,
}: {
  flags: AutoPaperBySleeve;
  variant: "header" | "essentials";
  onToggle: (sleeveId: SleeveId, enabled: boolean) => void;
}) {
  const wrap =
    variant === "essentials" ? "essentials-auto-chips" : "auto-sleeve-chips";
  const chip =
    variant === "essentials" ? "essentials-auto-chip" : "auto-sleeve-chip";
  return (
    <div className={wrap} role="group" aria-label="AUTO PAPER per sleeve">
      {AUTO_SLEEVE_CHIPS.map((c) => {
        const on = flags[c.id] === true;
        return (
          <button
            key={c.id}
            type="button"
            className={`${chip} ${on ? "on" : "off"}`}
            aria-pressed={on}
            aria-label={`AUTO ${c.label} ${on ? "on" : "off"}`}
            title={`${c.label} AUTO PAPER ${on ? "ON" : "OFF"}`}
            data-sleeve={c.id}
            onClick={() => onToggle(c.id, !on)}
          >
            {c.initial}
          </button>
        );
      })}
    </div>
  );
}
