// Turns DAT video frames into JPEGs (longest side <= 480 px, q 0.5) and sends each as one binary WebSocket
// message, preceded by a text message {"t": capture ms since 1970, "fps": send fps} for latency readouts.
// Drops frames while an encode/send is in flight or faster than maxFPS, so it never queues up lag.

import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import UIKit

final class FrameSender: @unchecked Sendable {
  private let url: URL
  private let maxFPS: Double
  private let maxSide: CGFloat = 480
  private let jpegQuality: CGFloat = 0.5
  private let urlSession = URLSession(configuration: .default)
  private let encodeQueue = DispatchQueue(label: "glasses.encode", qos: .userInitiated)
  private let ciContext = CIContext()
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

  private let lock = NSLock()
  private var task: URLSessionWebSocketTask?
  private var inFlight = false
  private var lastSendTime: TimeInterval = 0
  private var stopped = false
  private var sentCount = 0
  private var receivedCount = 0
  private var isConnected = false
  private var lastFPS = 0

  /// Called (on a background queue) with each frame that was sent, for the on-phone preview.
  var onSent: (@Sendable (UIImage) -> Void)?

  init(url: URL, maxFPS: Double = 15) {
    self.url = url
    self.maxFPS = maxFPS
    connect()
  }

  /// Frames received from DAT and sent since the last call, and whether the last send succeeded.
  func takeStats() -> (received: Int, sent: Int, connected: Bool) {
    lock.lock()
    defer { lock.unlock() }
    let result = (receivedCount, sentCount, isConnected)
    lastFPS = sentCount
    receivedCount = 0
    sentCount = 0
    return result
  }

  func stop() {
    lock.lock()
    stopped = true
    let t = task
    task = nil
    lock.unlock()
    t?.cancel(with: .goingAway, reason: nil)
  }

  /// Called from the DAT frame publisher's thread.
  func handle(_ frame: VideoFrame) {
    let now = Date().timeIntervalSince1970
    lock.lock()
    receivedCount += 1
    // 0.8x slack: with frames every ~33 ms, a strict 1/15 s gap would only pass every third frame (10 fps).
    if stopped || inFlight || now - lastSendTime < 0.8 / maxFPS {
      lock.unlock()
      return
    }
    inFlight = true
    lastSendTime = now
    lock.unlock()

    // Convert off the DAT publisher's thread too, so its delivery never waits on us.
    encodeQueue.async { [weak self] in
      guard let self else { return }
      guard let jpeg = self.encode(frame) else {
        self.finishSend(ok: nil)
        return
      }
      self.lock.lock()
      let t = self.task
      let fps = self.lastFPS
      self.lock.unlock()
      guard let t else {
        self.finishSend(ok: false)
        return
      }
      // Same task, so the text and binary messages arrive in order; only the frame's completion matters.
      t.send(.string("{\"t\":\(Int64(now * 1000)),\"fps\":\(fps)}")) { _ in }
      t.send(.data(jpeg)) { [weak self] error in
        if let error {
          NSLog("[GlassesRelay] send failed: \(error.localizedDescription)")
        } else {
          if let onSent = self?.onSent, let image = UIImage(data: jpeg) { onSent(image) }
        }
        self?.finishSend(ok: error == nil)
      }
    }
  }

  // ok: true = sent, false = socket failed (reconnect), nil = frame skipped.
  private func finishSend(ok: Bool?) {
    lock.lock()
    inFlight = false
    if ok == true {
      sentCount += 1
      isConnected = true
    } else if ok == false {
      isConnected = false
    }
    lock.unlock()
    if ok == false {
      scheduleReconnect()
    }
  }

  private var reconnectPending = false

  private func scheduleReconnect() {
    lock.lock()
    if stopped || reconnectPending {
      lock.unlock()
      return
    }
    reconnectPending = true
    let old = task
    task = nil
    lock.unlock()
    old?.cancel(with: .goingAway, reason: nil)
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.reconnectPending = false
      self.lock.unlock()
      self.connect()
    }
  }

  private func connect() {
    lock.lock()
    if stopped {
      lock.unlock()
      return
    }
    let t = urlSession.webSocketTask(with: url)
    task = t
    lock.unlock()
    t.resume()
  }

  /// Pixel buffer -> scaled JPEG in one Core Image pass. frame.makeUIImage() alone took 80-120 ms per
  /// frame (Simulator, 360x640), which capped sending at ~7 fps; this path is the fallback.
  private func encode(_ frame: VideoFrame) -> Data? {
    guard let pixels = CMSampleBufferGetImageBuffer(frame.sampleBuffer) else {
      guard let image = frame.makeUIImage() else { return nil }
      return downscale(image).jpegData(compressionQuality: jpegQuality)
    }
    var image = CIImage(cvPixelBuffer: pixels)
    let longest = max(image.extent.width, image.extent.height)
    if longest > maxSide {
      let k = maxSide / longest
      image = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
    }
    let opts = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): jpegQuality]
    return ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: opts)
  }

  private func downscale(_ image: UIImage) -> UIImage {
    let size = image.size
    let longest = max(size.width, size.height)
    guard longest > maxSide else { return image }
    let k = maxSide / longest
    let target = CGSize(width: (size.width * k).rounded(), height: (size.height * k).rounded())
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: target))
    }
  }
}
