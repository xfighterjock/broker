import { symbolDescription, symbolHoverTitle } from "../../shared/symbolDescriptions";

/** Primary ticker label. Known Event Gate symbols expose a hover full name. */
export function SymbolLabel({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  const description = symbolDescription(symbol);
  const classes = className ? `sym-tip ${className}` : "sym-tip";
  return (
    <span
      className={classes}
      title={symbolHoverTitle(symbol)}
      aria-label={description ? `${symbol}: ${description}` : undefined}
    >
      {symbol}
    </span>
  );
}

/** Inline list of tickers, each with its own hover description. */
export function SymbolList({
  symbols,
  className,
}: {
  symbols: readonly string[];
  className?: string;
}) {
  return (
    <span className={className ? `sym-list ${className}` : "sym-list"}>
      {symbols.map((symbol, i) => (
        <span key={`${symbol}-${i}`}>
          {i > 0 ? <span className="sym-sep"> / </span> : null}
          <SymbolLabel symbol={symbol} />
        </span>
      ))}
    </span>
  );
}
