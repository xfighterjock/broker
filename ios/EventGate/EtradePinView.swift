import SwiftUI

struct EtradePinView: View {
    @EnvironmentObject private var status: StatusController

    var body: some View {
        let auth = status.snapshot?.etradeAuth
        if auth == "needs_pin" || auth == "error" {
            VStack(alignment: .leading, spacing: 10) {
                Text(auth == "needs_pin" ? "E*TRADE needs PIN" : "E*TRADE error")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color(red: 0.90, green: 0.69, blue: 0.24))
                HStack {
                    Button("Authorize") {
                        Task { await status.startEtradeAuthorize() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(status.busy)
                    if status.authorizeOpened {
                        Button("Open again") {
                            Task { await status.retryEtradeAuthorize() }
                        }
                        .disabled(status.busy)
                    }
                }
                HStack {
                    TextField("PIN", text: $status.pin)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                    Button("Submit PIN") {
                        Task { await status.submitEtradePin() }
                    }
                    .disabled(status.busy || status.pin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.16, green: 0.12, blue: 0.04))
        }
    }
}
