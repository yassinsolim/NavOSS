#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Metrics: Codable {
  let destinationRedRatio: Double
  let dominantRatio: Double
  let height: Int
  let luminanceVariance: Double
  let nonBackgroundRatio: Double
  let path: String
  let mapLibrePuckRatio: Double
  let perceptualSignature: [Int]
  let quantizedColorCount: Int
  let recognizedText: [String]
  let originGreenRatio: Double
  let routeBlueRatio: Double
  /// The NavOSS vehicle marker's mean height within the map, 0 (top) to 1 (bottom); -1 if absent.
  let vehicleMarkerFrameY: Double
  let vehicleMarkerRatio: Double
  let width: Int
}

func analyze(path: String) throws -> Metrics {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let source = CGImageSourceCreateWithURL(url, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    throw NSError(domain: "NavOSSPng", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot decode \(path)"])
  }

  let width = image.width
  let height = image.height
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  guard let context = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    throw NSError(domain: "NavOSSPng", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot create bitmap context"])
  }
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

  let stride = max(1, Int(sqrt(Double(width * height) / 120_000)))
  var colors: [UInt32: Int] = [:]
  var luminanceSum = 0.0
  var luminanceSquaredSum = 0.0
  var sampleCount = 0
  var nearBackgroundCount = 0
  var destinationRedCount = 0
  var originGreenCount = 0
  var routeBlueCount = 0

  for y in Swift.stride(from: 0, to: height, by: stride) {
    for x in Swift.stride(from: 0, to: width, by: stride) {
      let offset = (y * width + x) * 4
      let red = pixels[offset]
      let green = pixels[offset + 1]
      let blue = pixels[offset + 2]
      let quantized = (UInt32(red >> 4) << 8) | (UInt32(green >> 4) << 4) | UInt32(blue >> 4)
      colors[quantized, default: 0] += 1
      let luminance = 0.2126 * Double(red) + 0.7152 * Double(green) + 0.0722 * Double(blue)
      luminanceSum += luminance
      luminanceSquaredSum += luminance * luminance
      if max(red, green, blue) - min(red, green, blue) < 5 && (luminance < 10 || luminance > 245) {
        nearBackgroundCount += 1
      }
      // The CarPlay route blue: #2F7BF6 on the light map, #5B9BFF on the dark one.
      if Int(blue) > 200 && Int(red) < 120 && Int(blue) > Int(red) + 110 && Int(green) > 90
        && Int(green) < 185
      {
        routeBlueCount += 1
      }
      if Int(red) < 90 && Int(green) > 160 && Int(blue) >= 50 && Int(blue) < 130
        && Int(green) > Int(blue) + 70
      {
        originGreenCount += 1
      }
      // The coral destination dot, #E5484D.
      if Int(red) > 200 && Int(green) < 110 && Int(blue) < 120 && Int(red) > Int(green) + 100 {
        destinationRedCount += 1
      }
      sampleCount += 1
    }
  }

  // The NavOSS vehicle marker (the arrow's teal disc, #0F8F7F) and MapLibre's own user-location
  // puck (its blue, about #0088F8), with the marker's height within the map. The harness
  // letterboxes the CarPlay frame on black, so the map is the band of rows that are mostly lit.
  var frameTop = height
  var frameBottom = -1
  var vehicleMarkerCount = 0
  var vehicleMarkerYSum = 0.0
  var mapLibrePuckCount = 0
  for y in Swift.stride(from: 0, to: height, by: stride) {
    var lit = 0
    var total = 0
    for x in Swift.stride(from: 0, to: width, by: stride) {
      let offset = (y * width + x) * 4
      let red = Int(pixels[offset])
      let green = Int(pixels[offset + 1])
      let blue = Int(pixels[offset + 2])
      total += 1
      if max(red, green, blue) > 24 { lit += 1 }
      if red < 70 && green >= 115 && green <= 175 && blue >= 95 && blue <= 160
        && green > red + 60 && green > blue
      {
        vehicleMarkerCount += 1
        vehicleMarkerYSum += Double(y)
      }
      if red < 24 && green >= 120 && green <= 160 && blue > 235 {
        mapLibrePuckCount += 1
      }
    }
    if lit * 2 > total {
      frameTop = min(frameTop, y)
      frameBottom = max(frameBottom, y)
    }
  }
  let vehicleMarkerFrameY =
    vehicleMarkerCount > 0 && frameBottom > frameTop
    ? (vehicleMarkerYSum / Double(vehicleMarkerCount) - Double(frameTop))
      / Double(frameBottom - frameTop)
    : -1

  let mean = luminanceSum / Double(sampleCount)
  let variance = max(0, luminanceSquaredSum / Double(sampleCount) - mean * mean)
  let dominant = colors.values.max() ?? sampleCount
  let signatureColumns = 12
  let signatureRows = 12
  var perceptualSignature: [Int] = []
  for row in 0..<signatureRows {
    for column in 0..<signatureColumns {
      let sampleX = min(width - 1, column * width / signatureColumns + width / (signatureColumns * 2))
      let sampleY = min(height - 1, row * height / signatureRows + height / (signatureRows * 2))
      let offset = (sampleY * width + sampleX) * 4
      let luminance =
        0.2126 * Double(pixels[offset]) + 0.7152 * Double(pixels[offset + 1])
        + 0.0722 * Double(pixels[offset + 2])
      perceptualSignature.append(Int(luminance.rounded()))
    }
  }
  let textRequest = VNRecognizeTextRequest()
  textRequest.recognitionLevel = .fast
  try VNImageRequestHandler(cgImage: image).perform([textRequest])
  let recognizedText = (textRequest.results ?? []).compactMap {
    $0.topCandidates(1).first?.string
  }
  return Metrics(
    destinationRedRatio: Double(destinationRedCount) / Double(sampleCount),
    dominantRatio: Double(dominant) / Double(sampleCount),
    height: height,
    luminanceVariance: variance,
    nonBackgroundRatio: 1 - Double(nearBackgroundCount) / Double(sampleCount),
    path: path,
    mapLibrePuckRatio: Double(mapLibrePuckCount) / Double(sampleCount),
    perceptualSignature: perceptualSignature,
    quantizedColorCount: colors.count,
    recognizedText: recognizedText,
    originGreenRatio: Double(originGreenCount) / Double(sampleCount),
    routeBlueRatio: Double(routeBlueCount) / Double(sampleCount),
    vehicleMarkerFrameY: vehicleMarkerFrameY,
    vehicleMarkerRatio: Double(vehicleMarkerCount) / Double(sampleCount),
    width: width
  )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let metrics = try CommandLine.arguments.dropFirst().map(analyze)
FileHandle.standardOutput.write(try encoder.encode(metrics))
FileHandle.standardOutput.write(Data("\n".utf8))
