// Voice commands from the glasses mic: DAT's Speech capability transcribes on the glasses, and each
// partial and final result goes to the laptop as {"type":"transcript","text","final"} on the relay
// socket (the laptop decides whether it's a command: after a Select pinch, or "Always listen").
// The recognizer can stop on its own (link changes, silence), so it's started again a moment later,
// a few times in a row at most.

import Foundation
import MWDATCore
import MWDATSpeech

final class GlassesSpeech: @unchecked Sendable {
  private let speech: Speech
  private let lock = NSLock()
  private var stopped = false
  private var wasStarted = false
  private var restarts = 0
  private static let maxRestarts = 5

  /// Called (on a background queue) with each transcription result.
  var onTranscript: (@Sendable (_ text: String, _ isFinal: Bool) -> Void)?
  /// Called (on a background queue) with state changes and errors, for the phone's status line.
  var onStatus: (@Sendable (String) -> Void)?

  /// nil when these glasses have no on-device speech.
  static func attach(to session: DeviceSession, tokens: ListenerTokenBag) throws(DeviceSessionError) -> GlassesSpeech? {
    guard let speech = try session.addSpeech() else { return nil }
    return GlassesSpeech(speech: speech, tokens: tokens)
  }

  private init(speech: Speech, tokens: ListenerTokenBag) {
    self.speech = speech
    speech.transcriptionPublisher.listen { [weak self] result in
      guard let self else { return }
      self.lock.lock()
      self.restarts = 0 // it's hearing things, so it's healthy
      self.lock.unlock()
      self.onTranscript?(result.text, result.isFinal)
    }.store(in: tokens)
    speech.statePublisher.listen { [weak self] state in
      self?.stateChanged(state)
    }.store(in: tokens)
    speech.errorPublisher.listen { [weak self] error in
      self?.onStatus?("Speech error: \(error.description)")
    }.store(in: tokens)
  }

  func start() {
    speech.start()
  }

  func stop() {
    lock.lock()
    stopped = true
    lock.unlock()
    speech.stop()
  }

  private func stateChanged(_ state: SpeechState) {
    onStatus?("Speech: \(state)")
    lock.lock()
    if state == .started { wasStarted = true }
    // .stopped is also the state it starts in; only a recognizer that was running is restarted.
    let restart = state == .stopped && wasStarted && !stopped && restarts < Self.maxRestarts
    if restart { restarts += 1 }
    lock.unlock()
    guard restart else { return }
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let go = !self.stopped && self.speech.state == .stopped
      self.lock.unlock()
      if go { self.speech.start() }
    }
  }
}
