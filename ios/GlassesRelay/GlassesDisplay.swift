// Puts the laptop's overlay on the Meta Ray-Ban Display through DAT's Display capability.
// The overlay is a 600x600 PNG made by src/edit/glassesOverlay.ts: black (see-through on the additive
// display) except for the edit, the selection outline and a status strip. Each Display send replaces
// the whole screen, so only the newest overlay matters: while a send is in flight, newer overlays
// replace each other and the latest goes out when it finishes (the same "latest wins" as the frames).
// Kept out of SwiftUI files: MWDATDisplay's Image/Text would clash with SwiftUI's names.

import Foundation
import MWDATCore
import MWDATDisplay
import UIKit

enum OverlayMessage: Sendable {
  case png(Data)
  case clear
}

final class GlassesDisplay: @unchecked Sendable {
  private enum Next {
    case image(UIImage)
    case clear
  }

  private let display: Display
  private let lock = NSLock()
  private var started = false
  private var sending = false
  private var stopped = false
  private var pending: Next?
  private var shown = 0

  /// Called (on a background queue) with the number of overlays shown so far.
  var onShown: (@Sendable (Int) -> Void)?
  /// Called (on a background queue) with display state changes and send errors.
  var onStatus: (@Sendable (String) -> Void)?

  /// Adds a Display to a started session (call after the session reaches `.started`).
  static func attach(to session: DeviceSession, tokens: ListenerTokenBag) throws(DeviceSessionError) -> GlassesDisplay {
    GlassesDisplay(display: try session.addDisplay(), tokens: tokens)
  }

  private init(display: Display, tokens: ListenerTokenBag) {
    self.display = display
    display.statePublisher.listen { [weak self] state in
      self?.stateChanged(state)
    }.store(in: tokens)
    display.start()
    stateChanged(display.state)
  }

  func handle(_ message: OverlayMessage) {
    switch message {
    case .png(let data):
      guard let image = UIImage(data: data, scale: 1) else { return }
      enqueue(.image(image))
    case .clear:
      enqueue(.clear)
    }
  }

  func stop() {
    lock.lock()
    stopped = true
    pending = nil
    lock.unlock()
    display.stop()
  }

  private func stateChanged(_ state: DisplayState) {
    lock.lock()
    started = state == .started
    lock.unlock()
    onStatus?("Display: \(state)")
    if state == .started { pump() }
  }

  private func enqueue(_ next: Next) {
    lock.lock()
    pending = next
    lock.unlock()
    pump()
  }

  private func pump() {
    lock.lock()
    guard started, !stopped, !sending, let next = pending else {
      lock.unlock()
      return
    }
    pending = nil
    sending = true
    lock.unlock()

    Task { [weak self] in
      guard let self else { return }
      do {
        switch next {
        case .image(let image):
          // One full-screen image; its black pixels emit no light, so the world shows through.
          try await self.display.send(
            FlexBox(direction: .column, alignment: .center, crossAlignment: .center) {
              Image(image: image, sizePreset: .fill)
            }
          )
        case .clear:
          try await self.display.clearDisplay()
        }
        self.lock.lock()
        self.shown += 1
        let n = self.shown
        self.lock.unlock()
        self.onShown?(n)
      } catch {
        self.onStatus?("Display error: \((error as? DisplayError)?.description ?? error.localizedDescription)")
      }
      self.lock.lock()
      self.sending = false
      self.lock.unlock()
      self.pump()
    }
  }
}
