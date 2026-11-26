import AVFoundation
import Foundation

/// Speaks guidance prompts so that every piece of audio I/O is one this app can stop.
///
/// `AVSpeechSynthesizer.speak` plays through an audio queue the synthesizer owns: it keeps that
/// queue running after `didFinish` and restarts it for each buffer, which brought the audio
/// session back after it had been deactivated. Here the synthesizer only renders
/// (`write(_:toBufferCallback:)`, which starts no audio I/O) and an `AVAudioPlayer` plays the
/// result; `stop()` ends both synchronously. Speaking directly remains as the fallback for a
/// voice that renders nothing.
///
/// Main queue only. Answers are delivered asynchronously on the main queue.
final class NavOSSGuidanceSpeechPlayer: NSObject, AVSpeechSynthesizerDelegate,
  AVAudioPlayerDelegate
{
  typealias PromptID = NavOSSGuidanceAudioLifecycle.PromptID

  enum Event {
    /// Rendering ended; `audioSeconds` is `nil` when nothing playable came out.
    case rendered(PromptID, audioSeconds: TimeInterval?)
    /// The player or the synthesizer finished the prompt, or it could not start.
    case finished(PromptID)
  }

  var onEvent: ((Event) -> Void)?

  /// Samples of one prompt, appended on whichever queue the synthesizer calls back on.
  private final class Rendering: @unchecked Sendable {
    let id: PromptID
    let utterance: AVSpeechUtterance
    private let lock = NSLock()
    private var format: NavOSSGuidanceSpeechPCMFormat?
    private var samples = Data()
    private var isUnplayable = false
    private var isComplete = false

    init(id: PromptID, utterance: AVSpeechUtterance) {
      self.id = id
      self.utterance = utterance
    }

    /// Returns `true` when `buffer` is the empty buffer that ends the prompt.
    func append(_ buffer: AVAudioBuffer) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      guard let buffer = buffer as? AVAudioPCMBuffer else {
        isUnplayable = true
        return false
      }
      guard buffer.frameLength > 0 else { return true }
      let description = buffer.format.streamDescription.pointee
      let flags = description.mFormatFlags
      let bufferFormat = NavOSSGuidanceSpeechPCMFormat(
        sampleRate: description.mSampleRate,
        channelCount: Int(description.mChannelsPerFrame),
        bitsPerSample: Int(description.mBitsPerChannel),
        isFloat: flags & kAudioFormatFlagIsFloat != 0
      )
      let isPackedLittleEndianPCM =
        description.mFormatID == kAudioFormatLinearPCM
        && flags & kAudioFormatFlagIsBigEndian == 0
        && (bufferFormat.isFloat || flags & kAudioFormatFlagIsSignedInteger != 0)
        && Int(description.mBytesPerFrame) * 8
          == Int(description.mBitsPerChannel)
          * (flags & kAudioFormatFlagIsNonInterleaved != 0 ? 1 : bufferFormat.channelCount)
      // One buffer per channel cannot be copied as interleaved frames.
      let isInterleaved =
        flags & kAudioFormatFlagIsNonInterleaved == 0 || bufferFormat.channelCount == 1
      let audio = buffer.audioBufferList.pointee.mBuffers
      let byteCount = Int(buffer.frameLength) * bufferFormat.channelCount
        * bufferFormat.bitsPerSample / 8
      guard isPackedLittleEndianPCM, isInterleaved, format == nil || format == bufferFormat,
        let bytes = audio.mData, Int(audio.mDataByteSize) >= byteCount
      else {
        isUnplayable = true
        return false
      }
      format = bufferFormat
      samples.append(bytes.assumingMemoryBound(to: UInt8.self), count: byteCount)
      return false
    }

    /// The finished prompt, once; `nil` after that or when nothing playable was rendered.
    func complete() -> (isFirst: Bool, file: NavOSSGuidanceSpeechWaveFile?) {
      lock.lock()
      defer { lock.unlock() }
      guard !isComplete else { return (false, nil) }
      isComplete = true
      guard !isUnplayable, let format else { return (true, nil) }
      return (true, NavOSSGuidanceSpeechWaveFile(format: format, samples: samples))
    }
  }

  private let synthesizer = AVSpeechSynthesizer()
  private var rendering: Rendering?
  private var rendered: (id: PromptID, file: NavOSSGuidanceSpeechWaveFile)?
  private var player: (id: PromptID, player: AVAudioPlayer)?
  private var direct: (id: PromptID, utterance: AVSpeechUtterance)?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  /// Whether anything is being rendered, played or spoken.
  var isBusy: Bool { rendering != nil || rendered != nil || player != nil || direct != nil }

  /// Renders `text` to audio without playing it. Answers `.rendered`.
  func render(_ id: PromptID, text: String) {
    let utterance = makeUtterance(text)
    let rendering = Rendering(id: id, utterance: utterance)
    self.rendering = rendering
    synthesizer.write(utterance) { [weak self] buffer in
      guard rendering.append(buffer) else { return }
      DispatchQueue.main.async { self?.finishRendering(rendering) }
    }
  }

  /// Plays the audio rendered for `id`. Answers `.finished` when it ends or cannot start.
  func play(_ id: PromptID) {
    guard let rendered, rendered.id == id else {
      answer(.finished(id))
      return
    }
    self.rendered = nil
    guard
      let audioPlayer = try? AVAudioPlayer(
        data: rendered.file.data, fileTypeHint: AVFileType.wav.rawValue)
    else {
      answer(.finished(id))
      return
    }
    audioPlayer.delegate = self
    player = (id, audioPlayer)
    if !audioPlayer.play() {
      player = nil
      answer(.finished(id))
    }
  }

  /// Speaks `text` through the synthesizer's own audio queue. Answers `.finished` on
  /// `didFinish`/`didCancel`; the queue runs on for a moment after that, so the caller waits
  /// before it calls `stop()` and deactivates.
  func speakDirectly(_ id: PromptID, text: String) {
    stop()
    let utterance = makeUtterance(text)
    utterance.preUtteranceDelay = 0.04
    direct = (id, utterance)
    synthesizer.speak(utterance)
  }

  /// Stops rendering, playback and direct speech now. No answer follows for what was stopped.
  func stop() {
    rendering = nil
    rendered = nil
    direct = nil
    if let player {
      self.player = nil
      player.player.delegate = nil
      player.player.stop()
    }
    synthesizer.stopSpeaking(at: .immediate)
  }

  private func makeUtterance(_ text: String) -> AVSpeechUtterance {
    let utterance = AVSpeechUtterance(string: text)
    utterance.pitchMultiplier = 1.02
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
    utterance.voice =
      AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language == "en-CA" }
      .max { $0.quality.rawValue < $1.quality.rawValue }
      ?? AVSpeechSynthesisVoice(language: "en-CA")
    return utterance
  }

  private func finishRendering(_ finished: Rendering) {
    let (isFirst, file) = finished.complete()
    guard isFirst, rendering === finished else { return }
    rendering = nil
    if let file {
      rendered = (finished.id, file)
    }
    answer(.rendered(finished.id, audioSeconds: file?.durationSeconds))
  }

  private func answer(_ event: Event) {
    DispatchQueue.main.async { [weak self] in
      self?.onEvent?(event)
    }
  }

  // MARK: AVSpeechSynthesizerDelegate

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance)
  {
    utteranceEnded(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance)
  {
    utteranceEnded(utterance)
  }

  private func utteranceEnded(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if let direct = self.direct, direct.utterance === utterance {
        self.direct = nil
        self.onEvent?(.finished(direct.id))
      } else if let rendering = self.rendering, rendering.utterance === utterance {
        // A voice that ends a render without the empty buffer still ends it here.
        self.finishRendering(rendering)
      }
    }
  }

  // MARK: AVAudioPlayerDelegate

  func audioPlayerDidFinishPlaying(_ audioPlayer: AVAudioPlayer, successfully flag: Bool) {
    playerEnded(audioPlayer)
  }

  func audioPlayerDecodeErrorDidOccur(_ audioPlayer: AVAudioPlayer, error: Error?) {
    playerEnded(audioPlayer)
  }

  private func playerEnded(_ audioPlayer: AVAudioPlayer) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let player = self.player, player.player === audioPlayer else { return }
      self.player = nil
      self.onEvent?(.finished(player.id))
    }
  }
}
