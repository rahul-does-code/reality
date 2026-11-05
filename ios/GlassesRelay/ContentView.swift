import SwiftUI

struct ContentView: View {
  @ObservedObject var model: RelayModel
  @State private var sayText = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Glasses Relay").font(.title2.bold())
      Text("Meta Wearables DAT · Mock Device Kit").font(.caption).foregroundStyle(.secondary)

      HStack {
        Text("Laptop IP")
        TextField("e.g. 192.168.1.20", text: $model.laptopIP)
          .textFieldStyle(.roundedBorder)
          .keyboardType(.numbersAndPunctuation)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .disabled(model.running)
      }
      Toggle("Ray-Ban Display (show edits on the glasses)", isOn: $model.useDisplay)
        .disabled(model.running)
      Toggle("Glasses mic (voice commands)", isOn: $model.useSpeech)
        .disabled(model.running)
      Text("Sends to ws://\(model.laptopIP.isEmpty ? "<laptop-ip>" : model.laptopIP):8788")
        .font(.caption.monospaced()).foregroundStyle(.secondary)

      Button(model.running ? "Stop" : "Start streaming") {
        if model.running {
          model.stop()
        } else {
          hideKeyboard()
          Task { await model.start() }
        }
      }
      .buttonStyle(.borderedProminent)
      .disabled(!model.running && model.laptopIP.trimmingCharacters(in: .whitespaces).isEmpty)

      Text(model.status).font(.callout)
      Text("DAT: \(model.datFPS) fps · sent: \(model.sentFPS) fps · \(model.connected ? "connected" : "not connected")")
        .font(.callout.monospacedDigit())
        .foregroundStyle(model.connected ? .green : .orange)
      if model.useDisplay && model.running {
        Text("\(model.displayStatus) · overlays shown: \(model.overlaysShown)")
          .font(.callout.monospacedDigit())
      }
      if model.useSpeech && model.running {
        Text("\(model.speechStatus) \(model.lastTranscript)").font(.callout)
        Toggle("Mock speech from the phone mic", isOn: $model.mockSpeechFromPhoneMic).font(.callout)
        HStack {
          TextField("or type what you'd say", text: $sayText)
            .textFieldStyle(.roundedBorder)
            .onSubmit(say)
          Button("Say", action: say).disabled(sayText.isEmpty)
        }
      }
      if let preview = model.displayPreview {
        // What the mock glasses display shows (black = see-through on real glasses).
        HostedView(view: preview)
          .aspectRatio(1, contentMode: .fit)
          .frame(maxHeight: 240)
          .background(Color.black)
          .clipShape(RoundedRectangle(cornerRadius: 8))
      }

      ZStack {
        Color.black
        if let image = model.preview {
          Image(uiImage: image).resizable().scaledToFit()
        } else {
          Text("No frames yet").foregroundStyle(.gray)
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .padding()
    .task {
      // Launch arguments "-laptopIP 127.0.0.1 -autostart YES" start streaming without tapping (simulator tests).
      if UserDefaults.standard.bool(forKey: "autostart") { await model.start() }
    }
  }

  private func say() {
    model.simulateSpeech(sayText)
    sayText = ""
  }

  private func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  }
}

/// Shows a UIKit view (the mock display preview) in SwiftUI.
struct HostedView: UIViewRepresentable {
  let view: UIView
  func makeUIView(context: Context) -> UIView { view }
  func updateUIView(_ uiView: UIView, context: Context) {}
}
