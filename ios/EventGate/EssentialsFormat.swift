import Foundation

enum SleeveChip: String, CaseIterable, Identifiable {
    case day
    case momentum
    case options
    case ownership
    case riskoff

    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: return "Day"
        case .momentum: return "Momentum"
        case .options: return "Options"
        case .ownership: return "Ownership"
        case .riskoff: return "Risk-off"
        }
    }

    var initial: String {
        switch self {
        case .day: return "D"
        case .momentum: return "M"
        case .options: return "O"
        case .ownership: return "Ow"
        case .riskoff: return "R"
        }
    }
}

enum EssentialsFormat {
    /// Must match `FLATTEN_CONFIRM` in client/src/essentials.ts
    static let flattenConfirm =
        "Flatten gated paper positions? This is the print-day / emergency veto (MockBroker, not live)."

    static let etradeAuthorizePrefix = "https://us.etrade.com/e/t/etws/authorize?"

    static func gateModeClass(_ mode: String) -> String {
        if mode == "PRE-ARM" { return "pre" }
        if mode == "NO-STOP BAND" { return "band" }
        if mode == "SESSION FLATTEN" { return "flat" }
        return "idle"
    }

    static func formatPnlUsd(_ n: Double) -> String {
        let abs = String(format: "%.2f", Swift.abs(n))
        if n > 0 { return "+$\(abs)" }
        if n < 0 { return "-$\(abs)" }
        return "$\(abs)"
    }

    static func formatPnlPct(pnl: Double, equity: Double) -> String {
        guard equity.isFinite, equity != 0 else { return "" }
        let start = equity - pnl
        guard start.isFinite, start != 0 else { return "" }
        let pct = (pnl / start) * 100
        let sign = pct > 0 ? "+" : ""
        return "\(sign)\(String(format: "%.2f", pct))%"
    }

    static func autoPaperFlags(_ snap: StatusSnapshot) -> [SleeveChip: Bool] {
        var out: [SleeveChip: Bool] = [:]
        if let raw = snap.autoPaperBySleeve {
            for chip in SleeveChip.allCases {
                out[chip] = raw[chip.rawValue] == true
            }
            return out
        }
        let allOn = snap.autoPaper != false
        for chip in SleeveChip.allCases { out[chip] = allOn }
        return out
    }

    static func autoPaperAnyOn(_ snap: StatusSnapshot) -> Bool {
        autoPaperFlags(snap).values.contains(true)
    }

    static func riskWhyLine(_ snap: StatusSnapshot) -> String {
        guard let c = snap.riskChecks else { return "SPY/ACWI/HYG 200dma + UUP 20d" }
        if snap.riskOn {
            let uup: String
            if let pct = c.uup20dPct, pct.isFinite {
                uup = "UUP 20d \(String(format: "%.1f", pct * 100))%"
            } else {
                uup = "UUP 20d n/a"
            }
            return "SPY/ACWI/HYG above 200dma · \(uup)"
        }
        var failed: [String] = []
        if c.spyAbove200 == false { failed.append("SPY below 200dma") }
        if c.acwiAbove200 == false { failed.append("ACWI below 200dma") }
        if c.hygAbove200 == false { failed.append("HYG below 200dma") }
        if c.dollarVeto == true {
            if let pct = c.uup20dPct, pct.isFinite {
                failed.append("UUP 20d \(String(format: "%.1f", pct * 100))% (dollar veto)")
            } else {
                failed.append("UUP 20d missing (dollar veto)")
            }
        }
        return failed.isEmpty ? "risk-off" : failed.joined(separator: " · ")
    }

    static func sleeveOpenHint(sleeveId: String, positions: [BrokerPosition]?) -> String? {
        guard let positions, !positions.isEmpty else { return nil }
        let open = positions.filter { p in
            let side = p.side ?? ""
            let qty = p.qty ?? 0
            guard side != "Flat", qty > 0 else { return false }
            let tagged = p.sleeveId
            if tagged == sleeveId { return true }
            if tagged == nil && sleeveId == "day" { return true }
            return false
        }
        if open.isEmpty { return nil }
        let lots = open.reduce(0.0) { $0 + ($1.qty ?? 0) }
        if lots == Double(open.count) { return "\(open.count) open" }
        return "\(open.count) open · \(Int(lots)) lots"
    }

    static func wantsEssentials(_ route: String) -> Bool {
        let path = route.split(separator: "?").first.map(String.init) ?? route
        let trimmed = path.split(separator: "#").first.map(String.init) ?? path
        return trimmed == "/status" || trimmed == "/m" || trimmed.hasPrefix("/m/")
    }

    static func isValidEtradeAuthorizeURL(_ url: String) -> Bool {
        url.hasPrefix(etradeAuthorizePrefix)
    }
}

struct SleevePnlRow: Identifiable {
    let id: String
    let label: String
    let daily: Double
    let total: Double
    let equity: Double
    let hint: String?

    static func rows(from snap: StatusSnapshot) -> [SleevePnlRow] {
        SleeveChip.allCases.map { chip in
            let book = snap.sleeveBooks?[chip.rawValue]
            let total = book?.totalPnlUsd ?? book?.pnlUsd ?? 0
            let daily = book?.dailyPnlUsd ?? 0
            let equity = book?.equityUsd ?? 100_000
            return SleevePnlRow(
                id: chip.rawValue,
                label: chip.label,
                daily: daily,
                total: total,
                equity: equity,
                hint: EssentialsFormat.sleeveOpenHint(sleeveId: chip.rawValue, positions: snap.broker.positions)
            )
        }
    }
}
