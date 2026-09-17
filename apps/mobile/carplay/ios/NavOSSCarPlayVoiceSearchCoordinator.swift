import AVFoundation
import CarPlay
internal import NavOSSNavigation
import Speech
import UIKit

/// Presents CarPlay's voice template while explicitly requested audio is captured for destination
/// search. Audio buffers and partial transcripts stay in memory only for this recognition session.
@MainActor
final class NavOSSCarPlayVoiceSearchCoordinator: NSObject {
  private enum CaptureState: Equatable {
    case idle
    case waitingForPresentation
    case requestingPermissions
    case listening
    case processing
  }

  private enum MicrophonePermission: Equatable {
    case denied
    case granted
    case undetermined
  }

  private enum VoiceControlState {
    static let listening = "listening"
    static let permission = "permission"
    static let processing = "processing"
    static let unavailable = "unavailable"
    static let error = "error"
  }

  private weak var interfaceController: CPInterfaceController?
  private let onRecognizedQuery: (String) -> Void

  private var audioEngine: AVAudioEngine?
  private var audioSessionObservers: [NSObjectProtocol] = []
  private var captureGeneration: UInt64 = 0
  private var captureState = CaptureState.idle
  private var finalizationTimer: Timer?
  private var lastPartialTranscript: String?
  private var maximumCaptureTimer: Timer?
  private var permissionPromptInFlight = false
  private var permissionPromptTimer: Timer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var silenceTimer: Timer?
  private var speechRecognizer: SFSpeechRecognizer?
  private var voiceInputLease: UUID?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var isDismissingVoiceTemplate = false

  init(
    interfaceController: CPInterfaceController,
    onRecognizedQuery: @escaping (String) -> Void
  ) {
    self.interfaceController = interfaceController
    self.onRecognizedQuery = onRecognizedQuery
  }

  /// Starts only after a deliberate CarPlay microphone tap.
  func start() {
    guard captureState == .idle, voiceTemplate == nil, let interfaceController else {
      return
    }

    captureGeneration &+= 1
    let generation = captureGeneration
    let template = makeVoiceTemplate()
    voiceTemplate = template
    captureState = .waitingForPresentation
    interfaceController.presentTemplate(template, animated: true) { [weak self] success, _ in
      MainActor.assumeIsolated {
        guard let self, self.isCurrent(generation) else {
          return
        }
        guard success else {
          self.voiceTemplate = nil
          self.captureState = .idle
          self.showRetryScreen(
            title: "Voice search unavailable",
            detail: "CarPlay could not start voice search. Try again."
          )
          return
        }
        self.preflightPermissions(generation: generation)
      }
    }
  }

  /// Cancels a user-initiated session and dismisses the modal voice UI when it is still present.
  func cancel() {
    endSession(dismissingVoiceTemplate: true)
  }

  /// Releases resources without trying to update a CarPlay scene that is disconnecting.
  func invalidate() {
    endSession(dismissingVoiceTemplate: false)
    interfaceController = nil
  }

  /// Called by the scene's `CPInterfaceControllerDelegate` implementation. On pre-26.4 systems,
  /// `CPVoiceControlTemplate` supplies its own dismissal control; observing it is how that built-in
  /// cancel/back flow stops recording immediately.
  func templateWillDisappear(_ template: CPTemplate) {
    guard let voiceTemplate, template === voiceTemplate, !isDismissingVoiceTemplate else {
      return
    }
    endSession(dismissingVoiceTemplate: false)
  }

  func templateDidDisappear(_ template: CPTemplate) {
    guard let voiceTemplate, template === voiceTemplate else {
      return
    }
    self.voiceTemplate = nil
    isDismissingVoiceTemplate = false
  }

  private func makeVoiceTemplate() -> CPVoiceControlTemplate {
    let template = CPVoiceControlTemplate(
      voiceControlStates: [
        CPVoiceControlState(
          identifier: VoiceControlState.listening,
          titleVariants: ["Listening…", "Say a destination"],
          image: UIImage(systemName: "mic.fill"),
          repeats: true
        ),
        CPVoiceControlState(
          identifier: VoiceControlState.processing,
          titleVariants: ["Processing…", "Finding your destination"],
          image: UIImage(systemName: "ellipsis"),
          repeats: true
        ),
        CPVoiceControlState(
          identifier: VoiceControlState.permission,
          titleVariants: ["Permission on iPhone", "Allow Microphone and Speech Recognition on your iPhone"],
          image: UIImage(systemName: "iphone"),
          repeats: false
        ),
        CPVoiceControlState(
          identifier: VoiceControlState.unavailable,
          titleVariants: ["On-device voice unavailable", "Download an English speech model or enable Dictation in iPhone Settings"],
          image: UIImage(systemName: "exclamationmark.triangle"),
          repeats: false
        ),
        CPVoiceControlState(
          identifier: VoiceControlState.error,
          titleVariants: ["Voice search needs another try", "No destination was recognized"],
          image: UIImage(systemName: "exclamationmark.circle"),
          repeats: false
        ),
      ]
    )

    // CPVoiceControlTemplate only exposes navigation bar buttons from iOS 26.4. Earlier systems
    // retain the modal template's built-in cancellation flow, observed above through its lifecycle.
    if #available(iOS 26.4, *) {
      template.trailingNavigationBarButtons = [
        CPBarButton(title: "Cancel") { [weak self] _ in
          self?.cancel()
        }
      ]
    }
    return template
  }

  private func preflightPermissions(generation: UInt64) {
    guard isCurrent(generation) else {
      return
    }

    let microphonePermission = microphonePermission()
    let speechPermission = SFSpeechRecognizer.authorizationStatus()
    if microphonePermission == .denied
      || speechPermission == .denied
      || speechPermission == .restricted
    {
      showFailure(
        state: VoiceControlState.permission,
        title: "Voice permission needed",
        detail: "On your iPhone, open Settings and allow Microphone and Speech Recognition for NavOSS, then try again.",
        generation: generation
      )
      return
    }

    let needsPermissionPrompt = microphonePermission == .undetermined
      || speechPermission == .notDetermined
    guard !needsPermissionPrompt || isPhoneForeground else {
      showFailure(
        state: VoiceControlState.permission,
        title: "Open NavOSS on your iPhone",
        detail: "Unlock and open NavOSS on your iPhone. Answer the Microphone and Speech Recognition prompts there, then tap the CarPlay microphone again.",
        generation: generation
      )
      return
    }

    guard needsPermissionPrompt else {
      startRecognition(generation: generation)
      return
    }
    guard !permissionPromptInFlight else {
      return
    }

    permissionPromptInFlight = true
    captureState = .requestingPermissions
    activateVoiceControlState(VoiceControlState.permission)
    schedulePermissionPromptTimeout(generation: generation)
    if microphonePermission == .undetermined {
      requestMicrophonePermission { [weak self] in
        guard let self, self.isAwaitingPermission(generation: generation) else {
          return
        }
        self.finishPermissionPrompt()
        self.preflightPermissions(generation: generation)
      }
    } else {
      SFSpeechRecognizer.requestAuthorization { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, self.isAwaitingPermission(generation: generation) else {
            return
          }
          self.finishPermissionPrompt()
          self.preflightPermissions(generation: generation)
        }
      }
    }
  }

  private func startRecognition(generation: UInt64) {
    guard isCurrent(generation) else {
      return
    }
    var recognizersByLocaleIdentifier: [String: SFSpeechRecognizer] = [:]
    let localeSelection = navOSSOnDeviceVoiceRecognitionLocale(
      deviceLocale: .current,
      supportedLocales: Array(SFSpeechRecognizer.supportedLocales())
    ) { locale in
      guard #available(iOS 13.0, *) else {
        return false
      }
      guard
        let recognizer = SFSpeechRecognizer(locale: locale),
        recognizer.isAvailable,
        recognizer.supportsOnDeviceRecognition
      else {
        return false
      }
      recognizersByLocaleIdentifier[locale.identifier] = recognizer
      return true
    }
    guard
      case let .available(locale) = localeSelection,
      let recognizer = recognizersByLocaleIdentifier[locale.identifier]
    else {
      showOnDeviceVoiceUnavailable(generation: generation)
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.taskHint = .search

    // Claim shared audio ownership before touching the recording category. This synchronously
    // stops guidance speech while ensuring its didCancel callback cannot deactivate our input.
    voiceInputLease = NavOSSNavigationService.shared.beginCarPlayVoiceInput()
    speechRecognizer = recognizer
    recognitionRequest = request

    let engine = AVAudioEngine()
    audioEngine = engine
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .measurement, options: [])
      try audioSession.setActive(true)

      let inputNode = engine.inputNode
      let recordingFormat = inputNode.outputFormat(forBus: 0)
      guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
        throw VoiceCaptureError.noAudio
      }
      inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { buffer, _ in
        request.append(buffer)
      }
      engine.prepare()
      try engine.start()
    } catch {
      showFailure(
        state: VoiceControlState.error,
        title: "No microphone audio",
        detail: "Check that your vehicle microphone is available, then try voice search again.",
        generation: generation
      )
      return
    }

    recognizer.queue = OperationQueue.main
    lastPartialTranscript = nil
    captureState = .listening
    activateVoiceControlState(VoiceControlState.listening)
    observeAudioSession(generation: generation)
    recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      MainActor.assumeIsolated {
        self?.receiveRecognition(result: result, error: error, generation: generation)
      }
    }
    scheduleSilenceTimer(after: 6, generation: generation)
    maximumCaptureTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
      self?.finishListeningForSilence(generation: generation)
    }
  }

  private func showOnDeviceVoiceUnavailable(generation: UInt64) {
    showFailure(
      state: VoiceControlState.unavailable,
      title: "On-device voice unavailable",
      detail: "Download an English speech model or enable Dictation in Settings on your iPhone, then try again.",
      generation: generation
    )
  }

  private func receiveRecognition(
    result: SFSpeechRecognitionResult?,
    error: Error?,
    generation: UInt64
  ) {
    guard isCurrent(generation), (captureState == .listening || captureState == .processing) else {
      return
    }

    if let result {
      let transcript = result.bestTranscription.formattedString
      if !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        lastPartialTranscript = transcript
        if result.isFinal {
          completeRecognition(transcript, generation: generation)
          return
        }
        if captureState == .listening {
          scheduleSilenceTimer(after: 1.6, generation: generation)
        }
      }
    }

    if error != nil {
      if speechRecognizer?.isAvailable == false, lastPartialTranscript == nil {
        showOnDeviceVoiceUnavailable(generation: generation)
      } else {
        completeWithLatestTranscript(generation: generation)
      }
    }
  }

  private func finishListeningForSilence(generation: UInt64) {
    guard isCurrent(generation), captureState == .listening else {
      return
    }
    captureState = .processing
    activateVoiceControlState(VoiceControlState.processing)
    silenceTimer?.invalidate()
    silenceTimer = nil
    maximumCaptureTimer?.invalidate()
    maximumCaptureTimer = nil
    stopMicrophoneCapture()
    finalizationTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
      self?.completeWithLatestTranscript(generation: generation)
    }
  }

  private func completeWithLatestTranscript(generation: UInt64) {
    guard isCurrent(generation), (captureState == .listening || captureState == .processing) else {
      return
    }
    if let lastPartialTranscript {
      completeRecognition(lastPartialTranscript, generation: generation)
    } else {
      showFailure(
        state: VoiceControlState.error,
        title: "No destination heard",
        detail: "Try voice search again and say a place or address.",
        generation: generation
      )
    }
  }

  private func completeRecognition(_ transcript: String, generation: UInt64) {
    guard isCurrent(generation), let query = navOSSVoiceDestinationQuery(transcript) else {
      showFailure(
        state: VoiceControlState.error,
        title: "No destination heard",
        detail: "Try voice search again and say a place or address.",
        generation: generation
      )
      return
    }

    captureState = .processing
    activateVoiceControlState(VoiceControlState.processing)
    tearDownCapture(cancelRecognition: true)
    captureState = .idle
    dismissVoiceTemplate(generation: generation) { [weak self] in
      guard let self, self.isCurrent(generation) else {
        return
      }
      self.onRecognizedQuery(query)
    }
  }

  private func showFailure(
    state: String,
    title: String,
    detail: String,
    generation: UInt64
  ) {
    guard isCurrent(generation) else {
      return
    }
    activateVoiceControlState(state)
    tearDownCapture(cancelRecognition: true)
    captureState = .idle
    dismissVoiceTemplate(generation: generation) { [weak self] in
      guard let self, self.isCurrent(generation) else {
        return
      }
      self.showRetryScreen(title: title, detail: detail)
    }
  }

  private func showRetryScreen(title: String, detail: String) {
    guard let interfaceController else {
      return
    }
    let message = CPListItem(text: detail, detailText: nil)
    message.isEnabled = false
    let retryItem = CPListItem(
      text: "Try voice search again",
      detailText: "Use the microphone"
    )
    let retryTemplate = CPListTemplate(
      title: title,
      sections: [CPListSection(items: [message, retryItem])]
    )
    retryItem.handler = { [weak self, weak retryTemplate] _, completion in
      completion()
      guard
        let self,
        let retryTemplate,
        let interfaceController = self.interfaceController,
        interfaceController.topTemplate === retryTemplate
      else {
        return
      }
      interfaceController.popTemplate(animated: true) { [weak self] success, _ in
        guard success else {
          return
        }
        self?.start()
      }
    }
    interfaceController.pushTemplate(retryTemplate, animated: true, completion: nil)
  }

  private func endSession(dismissingVoiceTemplate: Bool) {
    guard captureState != .idle || voiceTemplate != nil else {
      return
    }
    captureGeneration &+= 1
    tearDownCapture(cancelRecognition: true)
    captureState = .idle

    guard dismissingVoiceTemplate else {
      voiceTemplate = nil
      return
    }
    dismissVoiceTemplate(generation: captureGeneration, completion: {})
  }

  private func dismissVoiceTemplate(
    generation: UInt64,
    completion: @escaping () -> Void
  ) {
    guard let voiceTemplate, let interfaceController else {
      completion()
      return
    }
    guard interfaceController.presentedTemplate === voiceTemplate else {
      self.voiceTemplate = nil
      completion()
      return
    }

    isDismissingVoiceTemplate = true
    interfaceController.dismissTemplate(animated: true) { [weak self] success, _ in
      MainActor.assumeIsolated {
        guard let self else {
          return
        }
        self.isDismissingVoiceTemplate = false
        if self.voiceTemplate === voiceTemplate {
          self.voiceTemplate = nil
        }
        guard success, self.isCurrent(generation) else {
          return
        }
        completion()
      }
    }
  }

  private func tearDownCapture(cancelRecognition: Bool) {
    permissionPromptInFlight = false
    permissionPromptTimer?.invalidate()
    permissionPromptTimer = nil
    silenceTimer?.invalidate()
    silenceTimer = nil
    maximumCaptureTimer?.invalidate()
    maximumCaptureTimer = nil
    finalizationTimer?.invalidate()
    finalizationTimer = nil
    stopMicrophoneCapture()
    if cancelRecognition {
      recognitionTask?.cancel()
    }
    recognitionTask = nil
    recognitionRequest = nil
    speechRecognizer = nil
    lastPartialTranscript = nil

    guard let voiceInputLease else {
      return
    }
    self.voiceInputLease = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    NavOSSNavigationService.shared.finishCarPlayVoiceInput(voiceInputLease)
  }

  private func stopMicrophoneCapture() {
    guard let audioEngine else {
      return
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
    self.audioEngine = nil
    recognitionRequest?.endAudio()
    removeAudioSessionObservers()
  }

  private func observeAudioSession(generation: UInt64) {
    let center = NotificationCenter.default
    let audioSession = AVAudioSession.sharedInstance()
    audioSessionObservers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: audioSession,
        queue: .main
      ) { [weak self] notification in
        MainActor.assumeIsolated {
          guard
            let rawType = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?
              .uintValue,
            AVAudioSession.InterruptionType(rawValue: rawType) == .began
          else {
            return
          }
          self?.showFailure(
            state: VoiceControlState.error,
            title: "Voice search interrupted",
            detail: "Try voice search again when your vehicle audio is ready.",
            generation: generation
          )
        }
      },
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: audioSession,
        queue: .main
      ) { [weak self] notification in
        MainActor.assumeIsolated {
          guard
            let rawReason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?
              .uintValue,
            let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason),
            reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory
          else {
            return
          }
          self?.showFailure(
            state: VoiceControlState.error,
            title: "Vehicle audio changed",
            detail: "Try voice search again after your vehicle audio reconnects.",
            generation: generation
          )
        }
      },
    ]
  }

  private func removeAudioSessionObservers() {
    let center = NotificationCenter.default
    audioSessionObservers.forEach(center.removeObserver)
    audioSessionObservers.removeAll()
  }

  private func isAwaitingPermission(generation: UInt64) -> Bool {
    isCurrent(generation)
      && captureState == .requestingPermissions
      && permissionPromptInFlight
  }

  private func finishPermissionPrompt() {
    permissionPromptInFlight = false
    permissionPromptTimer?.invalidate()
    permissionPromptTimer = nil
  }

  private func schedulePermissionPromptTimeout(generation: UInt64) {
    permissionPromptTimer?.invalidate()
    permissionPromptTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) {
      [weak self] _ in
      guard let self, self.isAwaitingPermission(generation: generation) else {
        return
      }
      self.showFailure(
        state: VoiceControlState.permission,
        title: "Permission request timed out",
        detail: "Answer the Microphone and Speech Recognition prompts on your iPhone, then try again.",
        generation: generation
      )
    }
  }

  private func scheduleSilenceTimer(after interval: TimeInterval, generation: UInt64) {
    silenceTimer?.invalidate()
    silenceTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
      self?.finishListeningForSilence(generation: generation)
    }
  }

  private func activateVoiceControlState(_ identifier: String) {
    voiceTemplate?.activateVoiceControlState(withIdentifier: identifier)
  }

  private func isCurrent(_ generation: UInt64) -> Bool {
    captureGeneration == generation
  }

  private var isPhoneForeground: Bool {
    UIApplication.shared.connectedScenes.contains { scene in
      scene.session.role == .windowApplication && scene.activationState == .foregroundActive
    }
  }

  private func microphonePermission() -> MicrophonePermission {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .denied:
        return .denied
      case .granted:
        return .granted
      case .undetermined:
        return .undetermined
      @unknown default:
        return .denied
      }
    }

    switch AVAudioSession.sharedInstance().recordPermission {
    case .denied:
      return .denied
    case .granted:
      return .granted
    case .undetermined:
      return .undetermined
    @unknown default:
      return .denied
    }
  }

  private func requestMicrophonePermission(completion: @escaping () -> Void) {
    let completeOnMain: (Bool) -> Void = { _ in
      DispatchQueue.main.async {
        completion()
      }
    }
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completeOnMain)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completeOnMain)
    }
  }
}

private enum VoiceCaptureError: Error {
  case noAudio
}
