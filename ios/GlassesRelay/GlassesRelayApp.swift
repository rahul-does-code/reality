// Glasses Relay: gets camera frames from Meta's Wearables Device Access Toolkit (Mock Device Kit, so no
// real glasses are needed) and streams them as JPEGs over a WebSocket to the laptop running
// server/routes/glassesRelay.ts.

import MWDATCore
import SwiftUI

@main
struct GlassesRelayApp: App {
  @StateObject private var model = RelayModel()

  init() {
    do {
      try Wearables.configure()
    } catch {
      NSLog("[GlassesRelay] Wearables.configure failed: \(error)")
    }
  }

  var body: some Scene {
    WindowGroup {
      ContentView(model: model)
    }
  }
}
