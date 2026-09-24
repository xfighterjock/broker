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

/**
 * Open-lot day P/L already stored on the position (`dayPnl`).
 * Mark vs prior close (or option netChange), not account mock dayPnl and not uPnL.
 * Missing or non-finite stays blank — do not copy unrealizedPnl.
 */
export function blotterOpenDayPnl(
  position: Pick<Position, "side" | "qty" | "dayPnl">,
): number | null {
  if (position.side === "Flat" || !(position.qty > 0)) return null;
  if (position.dayPnl === null || position.dayPnl === undefined) return null;
  if (!Number.isFinite(position.dayPnl)) return null;
  return position.dayPnl;
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
            <th title="Day P/L, mark vs prior close">dPnL</th>
          </tr>
        </thead>
        <tbody>
          {open.map((p) => {
            const upl = blotterOpenUnrealizedPnl(p);
            const day = blotterOpenDayPnl(p);
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
                <td className={day === null ? "muted blotter-dpnl" : `${pnlClass(day)} blotter-dpnl`}>
                  {day === null ? "—" : formatPnlUsd(day)}
                </td>
              </tr>
            );
          })}
          {open.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                flat
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
