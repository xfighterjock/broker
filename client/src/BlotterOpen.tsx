import type { Position, SleeveId } from "../../shared/types";
import { formatPnlUsd } from "./essentials";
import { SymbolLabel } from "./SymbolLabel";

/**
 * Untagged mock lots sit on the day sleeve.
 * Same rule as server `positionBelongsToSleeve` and the paper-trade panel.
 */
export function blotterPositionOnSleeve(sleeveId: SleeveId, tagged?: SleeveId): boolean {
  if (tagged === sleeveId) return true;
  if (!tagged && sleeveId === "day") return true;
  return false;
}

/**
 * Open-lot mark already stored on the position (`unrealizedPnl`).
 * Flat or zero qty is not an open row — do not invent a P/L from a cleared book.
 */
export function blotterOpenUnrealizedPnl(
  position: Pick<Position, "side" | "qty" | "unrealizedPnl">,
): number | null {
  if (position.side === "Flat" || !(position.qty > 0)) return null;
  if (!Number.isFinite(position.unrealizedPnl)) return null;
  return position.unrealizedPnl;
}

function formatPx(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function pnlClass(n: number): string {
  if (n > 0) return "ok";
  if (n < 0) return "err";
  return "muted";
}

export function BlotterOpenPositions({
  sleeveId,
  positions,
}: {
  sleeveId: SleeveId;
  positions: Position[];
}) {
  const open = positions.filter(
    (p) => blotterPositionOnSleeve(sleeveId, p.sleeveId) && p.side !== "Flat" && p.qty > 0,
  );

  return (
    <>
      <label>Open positions</label>
      <table className="blotter-open">
        <thead>
          <tr>
            <th>Sym</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Avg</th>
            <th>uPnL</th>
          </tr>
        </thead>
        <tbody>
          {open.map((p) => {
            const upl = blotterOpenUnrealizedPnl(p);
            return (
              <tr key={p.id}>
                <td>
                  <SymbolLabel symbol={p.symbol} />
                </td>
                <td>{p.side}</td>
                <td>{p.qty}</td>
                <td>{formatPx(p.avgPrice)}</td>
                <td className={upl === null ? "muted blotter-upl" : `${pnlClass(upl)} blotter-upl`}>
                  {upl === null ? "—" : formatPnlUsd(upl)}
                </td>
              </tr>
            );
          })}
          {open.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                flat
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
