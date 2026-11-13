import Foundation

import zlib

// Streaming, fail-closed extraction of the shared `resources.tar.gz` artifact. Only regular files
// and directories are written; links, devices, absolute paths and `..` components are refused
// rather than skipped, because a resource archive that contains them is not one the pipeline built.

public enum NavOSSOfflineArchiveError: Error, Equatable, Sendable {
  case notGzip
  case corrupt(String)
  case unsafeEntry(String)
  case unsupportedEntry(String)
  case sizeLimitExceeded
}

/// Extracts the gzip-compressed tar at `archive` into `destination`, which must not exist yet.
/// Returns the number of file bytes written. Stops with `sizeLimitExceeded` once more than
/// `maximumBytes` would be written, so a hostile archive cannot fill the disk.
@discardableResult
public func navOSSExtractTarGzip(
  archive: URL,
  destination: URL,
  maximumBytes: Int64
) throws -> Int64 {
  let fileManager = FileManager.default
  try fileManager.createDirectory(at: destination, withIntermediateDirectories: false)
  let input = try FileHandle(forReadingFrom: archive)
  defer { try? input.close() }
  var tar = TarStreamWriter(root: destination, maximumBytes: maximumBytes)
  defer { tar.closeCurrentFile() }
  let inflater = try GzipInflater()
  while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
    try inflater.feed(chunk) { try tar.consume($0) }
  }
  try inflater.finish()
  try tar.finish()
  return tar.writtenBytes
}

/// Extracts an uncompressed tar with the same safety rules as `navOSSExtractTarGzip`.
@discardableResult
public func navOSSExtractTar(archive: URL, destination: URL, maximumBytes: Int64) throws -> Int64 {
  try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
  let input = try FileHandle(forReadingFrom: archive)
  defer { try? input.close() }
  var tar = TarStreamWriter(root: destination, maximumBytes: maximumBytes)
  defer { tar.closeCurrentFile() }
  while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
    try tar.consume(chunk)
  }
  try tar.finish()
  return tar.writtenBytes
}

/// Validates a tar member name and returns its relative path components.
public func navOSSSafeArchivePath(_ name: String) throws -> [String] {
  var trimmed = name
  while trimmed.hasPrefix("./") { trimmed.removeFirst(2) }
  while trimmed.hasSuffix("/") { trimmed.removeLast() }
  guard !trimmed.isEmpty, !trimmed.hasPrefix("/"), !trimmed.contains("\\"),
    !trimmed.contains("\0")
  else {
    throw NavOSSOfflineArchiveError.unsafeEntry(name)
  }
  let components = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
    throw NavOSSOfflineArchiveError.unsafeEntry(name)
  }
  return components
}

// MARK: - Gzip

/// Streaming gzip decoder on the system zlib, which also verifies the member's CRC-32 and size.
/// (Apple's Compression framework was not used: it silently stopped short of the end of the
/// real 61 MB resources archive.)
private final class GzipInflater {
  private var stream = z_stream()
  private let output: UnsafeMutablePointer<UInt8>
  private let outputSize = 1 << 20
  private var ended = false

  init() throws {
    output = .allocate(capacity: outputSize)
    // 16 + MAX_WBITS: gzip wrapper only, so a bare zlib or raw stream is rejected.
    guard
      inflateInit2_(&stream, 16 + MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        == Z_OK
    else {
      output.deallocate()
      throw NavOSSOfflineArchiveError.corrupt("inflate init")
    }
  }

  deinit {
    inflateEnd(&stream)
    output.deallocate()
  }

  func feed(_ chunk: Data, _ consume: (Data) throws -> Void) throws {
    guard !ended else { throw NavOSSOfflineArchiveError.corrupt("data after gzip member") }
    try chunk.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.bindMemory(to: Bytef.self).baseAddress else { return }
      stream.next_in = UnsafeMutablePointer(mutating: base)
      stream.avail_in = uInt(raw.count)
      repeat {
        stream.next_out = output
        stream.avail_out = uInt(outputSize)
        let status = inflate(&stream, Z_NO_FLUSH)
        let produced = outputSize - Int(stream.avail_out)
        if produced > 0 { try consume(Data(bytes: output, count: produced)) }
        switch status {
        case Z_OK, Z_BUF_ERROR where produced > 0:
          continue
        case Z_STREAM_END:
          ended = true
          guard stream.avail_in == 0 else {
            throw NavOSSOfflineArchiveError.corrupt("data after gzip member")
          }
          return
        case Z_DATA_ERROR where stream.total_out == 0 && produced == 0:
          throw NavOSSOfflineArchiveError.notGzip
        default:
          throw NavOSSOfflineArchiveError.corrupt("deflate stream")
        }
      } while stream.avail_in > 0 || stream.avail_out == 0
    }
  }

  func finish() throws {
    guard ended else {
      throw stream.total_in == 0
        ? NavOSSOfflineArchiveError.notGzip
        : NavOSSOfflineArchiveError.corrupt("truncated gzip stream")
    }
  }
}

// MARK: - Tar

private struct TarStreamWriter {
  let root: URL
  let maximumBytes: Int64
  private(set) var writtenBytes: Int64 = 0
  private var buffer = Data()
  private var remainingFileBytes: Int64 = 0
  private var paddingBytes: Int64 = 0
  private var currentFile: FileHandle?
  private var pendingPath: String?
  private var collectingPax: Data?
  private var collectingLongName: Data?
  private var sawEnd = false

  init(root: URL, maximumBytes: Int64) {
    self.root = root
    self.maximumBytes = maximumBytes
  }

  mutating func consume(_ data: Data) throws {
    buffer.append(data)
    var offset = 0
    defer { buffer.removeSubrange(0..<offset) }
    while true {
      if remainingFileBytes > 0 {
        let available = buffer.count - offset
        guard available > 0 else { return }
        let take = Int(min(Int64(available), remainingFileBytes))
        let slice = buffer.subdata(in: offset..<(offset + take))
        if collectingPax != nil {
          collectingPax?.append(slice)
        } else if collectingLongName != nil {
          collectingLongName?.append(slice)
        } else {
          try currentFile?.write(contentsOf: slice)
        }
        offset += take
        remainingFileBytes -= Int64(take)
        if remainingFileBytes == 0 { try finishMember() }
        continue
      }
      if paddingBytes > 0 {
        let take = Int(min(Int64(buffer.count - offset), paddingBytes))
        guard take > 0 else { return }
        offset += take
        paddingBytes -= Int64(take)
        continue
      }
      guard buffer.count - offset >= 512 else { return }
      let block = [UInt8](buffer.subdata(in: offset..<(offset + 512)))
      offset += 512
      if block.allSatisfy({ $0 == 0 }) {
        sawEnd = true
        continue
      }
      guard !sawEnd else { throw NavOSSOfflineArchiveError.corrupt("data after end of archive") }
      try startMember(block)
    }
  }

  mutating func finish() throws {
    guard sawEnd, remainingFileBytes == 0, currentFile == nil else {
      throw NavOSSOfflineArchiveError.corrupt("truncated tar archive")
    }
  }

  mutating func closeCurrentFile() {
    try? currentFile?.close()
    currentFile = nil
  }

  private mutating func startMember(_ block: [UInt8]) throws {
    guard Self.checksumMatches(block) else { throw NavOSSOfflineArchiveError.corrupt("checksum") }
    let size = try Self.size(block)
    let type = block[156]
    var name = Self.string(block[0..<100])
    let prefix = Self.string(block[345..<500])
    if Array(block[257..<262]) == Array("ustar".utf8), !prefix.isEmpty {
      name = "\(prefix)/\(name)"
    }
    if let override = pendingPath {
      name = override
      pendingPath = nil
    }
    remainingFileBytes = size
    paddingBytes = (512 - size % 512) % 512
    switch type {
    case UInt8(ascii: "x"):
      collectingPax = Data()
    case UInt8(ascii: "g"):
      collectingPax = Data()
      pendingGlobal = true
    case UInt8(ascii: "L"):
      collectingLongName = Data()
    case UInt8(ascii: "0"), 0:
      let components = try navOSSSafeArchivePath(name)
      writtenBytes += size
      guard writtenBytes <= maximumBytes else { throw NavOSSOfflineArchiveError.sizeLimitExceeded }
      let url = components.reduce(root) { $0.appending(path: $1) }
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
        throw NavOSSOfflineArchiveError.corrupt("cannot create \(name)")
      }
      currentFile = try FileHandle(forWritingTo: url)
      if size == 0 { try finishMember() }
    case UInt8(ascii: "5") where name == "." || name == "./":
      // The archive root itself.
      guard size == 0 else { throw NavOSSOfflineArchiveError.corrupt("directory with data") }
    case UInt8(ascii: "5"):
      let components = try navOSSSafeArchivePath(name)
      guard size == 0 else { throw NavOSSOfflineArchiveError.corrupt("directory with data") }
      try FileManager.default.createDirectory(
        at: components.reduce(root) { $0.appending(path: $1, directoryHint: .isDirectory) },
        withIntermediateDirectories: true)
    case UInt8(ascii: "1"), UInt8(ascii: "2"):
      throw NavOSSOfflineArchiveError.unsupportedEntry("link \(name)")
    default:
      throw NavOSSOfflineArchiveError.unsupportedEntry("type \(type) \(name)")
    }
  }

  private var pendingGlobal = false

  private mutating func finishMember() throws {
    if let pax = collectingPax {
      collectingPax = nil
      if pendingGlobal {
        pendingGlobal = false
      } else {
        pendingPath = try Self.paxPath(pax)
      }
    } else if let longName = collectingLongName {
      collectingLongName = nil
      pendingPath = Self.string(ArraySlice(longName))
    } else {
      try currentFile?.close()
      currentFile = nil
    }
  }

  /// Reads `path` from a pax extended header. Records are `<length> <key>=<value>\n` with the
  /// length in bytes; values (for example xattrs) may be binary, so this works on bytes.
  private static func paxPath(_ data: Data) throws -> String? {
    let bytes = [UInt8](data)
    var path: String?
    var offset = 0
    while offset < bytes.count {
      guard let space = bytes[offset...].firstIndex(of: UInt8(ascii: " ")),
        let length = Int(String(decoding: bytes[offset..<space], as: UTF8.self)), length > 0,
        offset + length <= bytes.count, bytes[offset + length - 1] == UInt8(ascii: "\n")
      else {
        throw NavOSSOfflineArchiveError.corrupt("pax header")
      }
      let record = bytes[(space + 1)..<(offset + length - 1)]
      if let equals = record.firstIndex(of: UInt8(ascii: "=")) {
        let key = String(decoding: record[record.startIndex..<equals], as: UTF8.self)
        let value = String(decoding: record[(equals + 1)...], as: UTF8.self)
        if key == "path" { path = value }
        if key == "linkpath" { throw NavOSSOfflineArchiveError.unsupportedEntry("pax linkpath") }
      }
      offset += length
    }
    return path
  }

  private static func string(_ bytes: ArraySlice<UInt8>) -> String {
    let content = bytes.prefix { $0 != 0 }
    return String(decoding: content, as: UTF8.self)
  }

  private static func size(_ block: [UInt8]) throws -> Int64 {
    let field = block[124..<136]
    if let first = field.first, first & 0x80 != 0 {
      // GNU base-256: big-endian two's complement in the remaining bytes.
      var value: Int64 = Int64(first & 0x7f)
      for byte in field.dropFirst() {
        guard value < (Int64.max >> 8) else { throw NavOSSOfflineArchiveError.corrupt("size") }
        value = value << 8 | Int64(byte)
      }
      return value
    }
    let text = string(field).trimmingCharacters(in: .whitespaces)
    guard let value = Int64(text.isEmpty ? "0" : text, radix: 8), value >= 0 else {
      throw NavOSSOfflineArchiveError.corrupt("size")
    }
    return value
  }

  private static func checksumMatches(_ block: [UInt8]) -> Bool {
    let stored = Int(string(block[148..<156]).trimmingCharacters(in: .whitespaces), radix: 8)
    var unsigned = 0
    for (index, byte) in block.enumerated() {
      unsigned += (148..<156).contains(index) ? 32 : Int(byte)
    }
    return stored == unsigned
  }
}
