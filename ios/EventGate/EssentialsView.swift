import SwiftUI

struct EssentialsView: View {
    @EnvironmentObject private var status: StatusController
    @EnvironmentObject private var push: PushController
    @State private var confirmFlatten = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                EtradePinView()
                summary
                riskBadge
                controls
                sleeves
                if let err = status.lastError, !err.isEmpty {
                    Text(err)
                        .foregroundStyle(Color(red: 0.89, green: 0.29, blue: 0.29))
                        .padding(16)
                }
            }
        }
        .background(Color(red: 0.03, green: 0.035, blue: 0.047))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color(red: 0.05, green: 0.06, blue: 0.09), for: .navigationBar)
        .onAppear {
            status.startPolling()
        }
        .onDisappear {
            // Keep polling while this is the root; Settings is pushed on top.
        }
        .confirmationDialog(
            EssentialsFormat.flattenConfirm,
            isPresented: $confirmFlatten,
            titleVisibility: .visible
        ) {
            Button("Flatten", role: .destructive) {
                Task { await status.flatten() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var snap: StatusSnapshot? { status.snapshot }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("EVENT GATE")
                .font(.caption.weight(.semibold))
                .tracking(1.6)
                .foregroundStyle(Color(red: 0.37, green: 0.78, blue: 0.86))
            Text("PAPER · MOCK")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color(red: 0.90, green: 0.69, blue: 0.24))
            Spacer()
            Text(snap?.clock?.nowEt ?? "—")
                .font(.body.monospaced())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(red: 0.05, green: 0.06, blue: 0.09))
    }

    private var summary: some View {
        let mode = snap?.clock?.mode ?? "idle"
        let gateOn = snap?.gateEnabled == true
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                badge(mode, kind: EssentialsFormat.gateModeClass(mode))
                badge(gateOn ? "GATE ON" : "GATE OFF", kind: gateOn ? "on" : "off")
            }
            Text(metaLine)
                .font(.subheadline)
                .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
        }
        .padding(16)
    }

    private var metaLine: String {
        guard let snap else { return "Loading…" }
        var parts = ["\(snap.broker.mode.uppercased()) · \(snap.broker.name)"]
        if let type = snap.clock?.focusEvent?.type, !type.isEmpty { parts.append(type) }
        if let cd = snap.clock?.countdownLabel, !cd.isEmpty { parts.append(cd) }
        return parts.joined(separator: " · ")
    }

    private var riskBadge: some View {
        let on = snap?.riskOn == true
        return VStack(spacing: 8) {
            Text(on ? "RISK ON" : "RISK OFF")
                .font(.title.monospaced().weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(on ? Color(red: 0.24, green: 0.75, blue: 0.48) : Color(red: 0.89, green: 0.29, blue: 0.29))
            Text(snap.map(EssentialsFormat.riskWhyLine) ?? "SPY/ACWI/HYG 200dma + UUP 20d")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(on ? Color(red: 0.62, green: 0.81, blue: 0.70) : Color(red: 0.94, green: 0.71, blue: 0.71))
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background(on ? Color(red: 0.06, green: 0.13, blue: 0.09) : Color(red: 0.16, green: 0.06, blue: 0.06))
    }

    private var controls: some View {
        let gateOn = snap?.gateEnabled == true
        let autoOn = snap.map(EssentialsFormat.autoPaperAnyOn) ?? false
        let flags = snap.map(EssentialsFormat.autoPaperFlags) ?? [:]
        return VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: Binding(
                get: { gateOn },
                set: { _ in Task { await status.toggleGate() } }
            )) {
                badge(gateOn ? "GATE ON" : "GATE OFF", kind: gateOn ? "on" : "off")
            }
            .disabled(status.busy || snap == nil)

            Toggle(isOn: Binding(
                get: { autoOn },
                set: { _ in Task { await status.toggleAutoPaper() } }
            )) {
                badge(autoOn ? "AUTO PAPER ON" : "AUTO PAPER OFF", kind: autoOn ? "on" : "off")
            }
            .disabled(status.busy || snap == nil)

            HStack(spacing: 6) {
                ForEach(SleeveChip.allCases) { chip in
                    let on = flags[chip] == true
                    Button(chip.initial) {
                        Task { await status.toggleAutoSleeve(chip.rawValue, enabled: !on) }
                    }
                    .buttonStyle(.bordered)
                    .tint(on ? Color(red: 0.24, green: 0.75, blue: 0.48) : Color(red: 0.49, green: 0.54, blue: 0.60))
                    .disabled(status.busy || snap == nil)
                    .accessibilityLabel("AUTO \(chip.label) \(on ? "on" : "off")")
                }
            }

            Button("Flatten") {
                confirmFlatten = true
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.89, green: 0.29, blue: 0.29))
            .frame(maxWidth: .infinity)
            .disabled(status.busy || snap == nil)

            Text("Print-day / emergency veto. Paper only.")
                .font(.footnote)
                .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
        }
        .padding(16)
    }

    private var sleeves: some View {
        let rows = snap.map(SleevePnlRow.rows(from:)) ?? []
        return VStack(alignment: .leading, spacing: 0) {
            Text("SLEEVES")
                .font(.caption.weight(.semibold))
                .tracking(1.6)
                .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 6)
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label).font(.body.weight(.semibold))
                        if let hint = row.hint {
                            Text(hint)
                                .font(.caption)
                                .foregroundStyle(Color(red: 0.49, green: 0.54, blue: 0.60))
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("d \(EssentialsFormat.formatPnlUsd(row.daily))")
                            .foregroundStyle(pnlColor(row.daily))
                        let pct = EssentialsFormat.formatPnlPct(pnl: row.total, equity: row.equity)
                        Text("tot \(EssentialsFormat.formatPnlUsd(row.total))\(pct.isEmpty ? "" : " \(pct)")")
                            .foregroundStyle(pnlColor(row.total))
                    }
                    .font(.subheadline.monospaced().weight(.semibold))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
    }

    private func pnlColor(_ n: Double) -> Color {
        if n > 0 { return Color(red: 0.24, green: 0.75, blue: 0.48) }
        if n < 0 { return Color(red: 0.89, green: 0.29, blue: 0.29) }
        return Color(red: 0.49, green: 0.54, blue: 0.60)
    }

    private func badge(_ text: String, kind: String) -> some View {
        let color: Color = {
            switch kind {
            case "pre": return Color(red: 0.90, green: 0.69, blue: 0.24)
            case "band": return Color(red: 0.89, green: 0.29, blue: 0.29)
            case "flat": return Color(red: 0.79, green: 0.65, blue: 1.0)
            case "on": return Color(red: 0.24, green: 0.75, blue: 0.48)
            default: return Color(red: 0.49, green: 0.54, blue: 0.60)
            }
        }()
        return Text(text)
            .font(.caption.weight(.semibold))
            .tracking(0.6)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .overlay(
                RoundedRectangle(cornerRadius: 3)
                    .stroke(color.opacity(0.5), lineWidth: 1)
            )
            .foregroundStyle(color)
    }
}
