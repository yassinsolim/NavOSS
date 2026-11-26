import Foundation

/// Linear PCM as `AVSpeechSynthesizer.write` delivers it, described without AVFoundation so the
/// container can be checked on the host.
public struct NavOSSGuidanceSpeechPCMFormat: Equatable, Sendable {
  public let sampleRate: Double
  public let channelCount: Int
  public let bitsPerSample: Int
  public let isFloat: Bool

  public init(sampleRate: Double, channelCount: Int, bitsPerSample: Int, isFloat: Bool) {
    self.sampleRate = sampleRate
    self.channelCount = channelCount
    self.bitsPerSample = bitsPerSample
    self.isFloat = isFloat
  }

  var bytesPerFrame: Int { channelCount * bitsPerSample / 8 }

  var isPlayable: Bool {
    guard sampleRate >= 8_000, sampleRate <= 192_000, sampleRate == sampleRate.rounded(),
      (1...2).contains(channelCount)
    else { return false }
    return isFloat ? bitsPerSample == 32 || bitsPerSample == 64 : [16, 24, 32].contains(bitsPerSample)
  }
}

/// One rendered guidance prompt as a WAV file in memory, ready for `AVAudioPlayer`.
public struct NavOSSGuidanceSpeechWaveFile: Equatable, Sendable {
  /// Silence appended so the last syllable has left the output before the player reports that
  /// it finished and the session is deactivated.
  public static let trailingSilenceSeconds = 0.2

  public let data: Data
  /// Length of the audio, including the trailing silence.
  public let durationSeconds: TimeInterval

  /// `samples` is little-endian, interleaved PCM in `format`. Returns `nil` when there is nothing
  /// to play or the format is not one a WAV file can carry.
  public init?(format: NavOSSGuidanceSpeechPCMFormat, samples: Data) {
    guard format.isPlayable else { return nil }
    let bytesPerFrame = format.bytesPerFrame
    let frames = samples.count / bytesPerFrame
    guard frames > 0 else { return nil }
    let silenceFrames = Int((Self.trailingSilenceSeconds * format.sampleRate).rounded())
    let payloadBytes = (frames + silenceFrames) * bytesPerFrame
    guard payloadBytes <= Int(UInt32.max) - 36 else { return nil }

    var file = Data(capacity: 44 + payloadBytes)
    func append<Value: FixedWidthInteger>(_ value: Value) {
      withUnsafeBytes(of: value.littleEndian) { file.append(contentsOf: $0) }
    }
    file.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36 + payloadBytes))
    file.append(contentsOf: Array("WAVE".utf8))
    file.append(contentsOf: Array("fmt ".utf8))
    append(UInt32(16))
    append(UInt16(format.isFloat ? 3 : 1))
    append(UInt16(format.channelCount))
    append(UInt32(format.sampleRate))
    append(UInt32(Int(format.sampleRate) * bytesPerFrame))
    append(UInt16(bytesPerFrame))
    append(UInt16(format.bitsPerSample))
    file.append(contentsOf: Array("data".utf8))
    append(UInt32(payloadBytes))
    file.append(samples.prefix(frames * bytesPerFrame))
    // Zero bytes are silence for signed integer and floating-point samples alike.
    file.append(Data(count: silenceFrames * bytesPerFrame))

    data = file
    durationSeconds = Double(frames + silenceFrames) / format.sampleRate
  }
}
