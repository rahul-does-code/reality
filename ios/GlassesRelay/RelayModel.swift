// Drives the DAT lifecycle against a Mock Device Kit device:
// enable mock -> pair mock Ray-Ban Meta -> give it a camera feed -> power on/unfold/don ->
// DeviceSession -> Camera stream (raw, low res, 15 fps) -> FrameSender.
// Real glasses would skip the MockDeviceKit block and need Meta AI app registration instead.

import AVFoundation
import MWDATCamera
import MWDATCore
import MWDATMockDevice
import SwiftUI

@MainActor
final class RelayModel: ObservableObject {
  @Published var laptopIP: String = UserDefaults.standard.string(forKey: "laptopIP") ?? "" {
    didSet { UserDefaults.standard.set(laptopIP, forKey: "laptopIP") }
  }
  @Published var status = "Idle"
  @Published var running = false
  @Published var preview: UIImage?
  @Published var sentFPS = 0
  @Published var datFPS = 0
  @Published var connected = false

  private let wearables = Wearables.shared
  private var glasses: (any MockGlasses)?
  private var session: DeviceSession?
  private var camera: MWDATCamera.Camera?
  private let tokens = ListenerTokenBag()
  private var sender: FrameSender?
  private var statsTimer: Timer?

  func start() async {
    guard !running else { return }
    let ip = laptopIP.trimmingCharacters(in: .whitespaces)
    guard let url = URL(string: "ws://\(ip):8788") else {
      status = "Bad IP: \(ip)"
      return
    }
    running = true

    do {
      // 1. Mock glasses. enable() starts registered with permissions granted (no Meta AI app needed).
      status = "Pairing mock glasses..."
      let kit = MockDeviceKit.shared
      if !kit.isEnabled { kit.enable() }
      let device = try kit.pairGlasses(model: .rayBanMeta)
      glasses = device

      #if targetEnvironment(simulator)
        // The simulator has no camera: the mock plays a bundled HEVC clip instead.
        guard let clip = Bundle.main.url(forResource: "mock-feed", withExtension: "mp4") else {
          throw RelayError("mock-feed.mp4 missing from the app bundle")
        }
        device.services.camera.setCameraFeed(fileURL: clip)
      #else
        // On a real iPhone the mock glasses "see" through the phone's back camera.
        guard await AVCaptureDevice.requestAccess(for: .video) else {
          throw RelayError("Camera permission denied (Settings > Glasses Relay > Camera)")
        }
        device.services.camera.setCameraFeed(cameraFacing: .back)
      #endif
      device.powerOn()
      device.unfold()
      device.don()

      // 2. Wait until the toolkit reports the (mock) device as available.
      status = "Waiting for device..."
      let selector = AutoDeviceSelector(wearables: wearables)
      guard await Self.waitForDevice(selector, seconds: 10) else {
        throw RelayError("Mock device never became available")
      }

      // 3. Device session.
      status = "Starting session..."
      let session = try wearables.createSession(deviceSelector: selector)
      self.session = session
      let states = session.stateStream()
      try session.start()
      for await state in states {
        if state == .started { break }
        if state == .stopped { throw RelayError("Session stopped while starting") }
      }

      if try await wearables.checkPermissionStatus(.camera) != .granted {
        guard try await wearables.requestPermission(.camera) == .granted else {
          throw RelayError("Toolkit camera permission denied")
        }
      }

      // 4. Camera stream -> JPEG -> WebSocket.
      status = "Starting camera stream..."
      let sender = FrameSender(url: url, maxFPS: 15)
      sender.onSent = { [weak self] image in
        Task { @MainActor in self?.preview = image }
      }
      self.sender = sender

      let config = StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 15)
      guard let camera = try session.addCamera(config: config) else {
        throw RelayError("Couldn't add camera to the session")
      }
      self.camera = camera
      camera.stream.statePublisher.listen { [weak self] state in
        Task { @MainActor in self?.status = "Stream: \(state)" }
      }.store(in: tokens)
      camera.stream.errorPublisher.listen { [weak self] error in
        Task { @MainActor in self?.status = "Stream error: \(error.localizedDescription)" }
      }.store(in: tokens)
      camera.stream.videoFramePublisher.listen { frame in
        sender.handle(frame)
      }.store(in: tokens)
      camera.stream.start()

      statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self, let sender = self.sender else { return }
          let stats = sender.takeStats()
          self.datFPS = stats.received
          self.sentFPS = stats.sent
          NSLog("[GlassesRelay] DAT \(stats.received) fps, sent \(stats.sent) fps")
          self.connected = stats.connected
        }
      }
    } catch {
      status = "Error: \(error.localizedDescription)"
      stop(keepStatus: true)
    }
  }

  func stop(keepStatus: Bool = false) {
    statsTimer?.invalidate()
    statsTimer = nil
    tokens.clear()
    sender?.stop()
    sender = nil
    camera?.stop()
    camera = nil
    session?.stop()
    session = nil
    if let glasses {
      MockDeviceKit.shared.unpairDevice(glasses)
    }
    glasses = nil
    running = false
    connected = false
    sentFPS = 0
    datFPS = 0
    if !keepStatus { status = "Stopped" }
  }

  private static func waitForDevice(_ selector: AutoDeviceSelector, seconds: Double) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await id in selector.activeDeviceStream() where id != nil {
          return true
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(for: .seconds(seconds))
        return false
      }
      let found = await group.next() ?? false
      group.cancelAll()
      return found
    }
  }
}

struct RelayError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
