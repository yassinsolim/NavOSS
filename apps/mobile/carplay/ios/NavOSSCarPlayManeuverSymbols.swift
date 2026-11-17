import CarPlay
internal import NavOSSNavigation
import UIKit

/// Draws turn-card symbols from a maneuver's kind and its geometry-measured exit angle, so a slight
/// fork, a sharp turn, and the third exit of a roundabout each look like the junction ahead
/// instead of sharing one generic arrow.
///
/// Images are template images: CarPlay tints them for the guidance card, Dashboard, and
/// notification banners in both light and dark appearances.
///
/// The image must be drawn at the car screen's own scale. CarPlay sends the maneuver to its host
/// as pixels and lays the card out from pixels ÷ the car display's scale: a 50 pt symbol rendered
/// at the phone's 3x reaches a 2x head unit as a 75 pt image, which CarPlay treats as a wide image
/// and puts on its own row above the distance (or, with a short instruction, drops the
/// instruction). At the car's scale it stays 50 pt and sits beside the distance.
@MainActor
enum NavOSSCarPlayManeuverSymbols {
  /// CarPlay's maximum for a symbol shown on the same row as the distance (CarPlay Developer
  /// Guide, "First maneuver symbol, symbol and instruction on one line": 50 pt × 50 pt).
  private static let canvas = CGSize(width: 50, height: 50)
  private static var cache: [String: UIImage] = [:]

  /// `displayScale` is the scale of the screen the symbol is shown on: the CarPlay window's for
  /// the guidance card, Dashboard and notifications.
  static func image(
    kind: NavOSSCarPlayManeuverKind,
    angleDegrees: Double,
    displayScale: CGFloat = 3
  ) -> UIImage? {
    let scale = max(1, displayScale.rounded())
    // Quantize the angle so near-identical junctions share one cached image.
    let angle = (max(-180, min(180, angleDegrees)) / 5).rounded() * 5
    let key = "\(kind)|\(angle)|\(scale)"
    if let cached = cache[key] { return cached }
    let image: UIImage?
    switch kind {
    case .arrive, .arriveLeft, .arriveRight:
      image = systemSymbol("flag.checkered", scale: scale)
    case .ferry:
      image = systemSymbol("ferry.fill", scale: scale)
    case .uTurn:
      image = render(scale: scale) { drawUTurn(in: $0) }
    case let .roundabout(exit):
      image = render(scale: scale) { drawRoundabout(exitAngle: angle, exit: exit, in: $0) }
    default:
      image = render(scale: scale) { drawTurn(angle: angle, in: $0) }
    }
    let template = image?.withRenderingMode(.alwaysTemplate)
    cache[key] = template
    return template
  }

  private static func render(scale: CGFloat, _ draw: (CGContext) -> Void) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = false
    return UIGraphicsImageRenderer(size: canvas, format: format).image { context in
      UIColor.black.setStroke()
      UIColor.black.setFill()
      draw(context.cgContext)
    }
  }

  /// An SF Symbol centred in the same 50 pt canvas at the same scale as the drawn arrows.
  private static func systemSymbol(_ name: String, scale: CGFloat) -> UIImage? {
    let configuration = UIImage.SymbolConfiguration(pointSize: 30, weight: .semibold)
    guard let symbol = UIImage(systemName: name, withConfiguration: configuration) else {
      return nil
    }
    return render(scale: scale) { _ in
      let size = symbol.size
      symbol.withTintColor(.black).draw(
        in: CGRect(
          x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2,
          width: size.width, height: size.height))
    }
  }

  /// Unit vector for an angle measured clockwise from straight up.
  private static func direction(_ degrees: Double) -> CGPoint {
    let radians = degrees * .pi / 180
    return CGPoint(x: sin(radians), y: -cos(radians))
  }

  private static func drawArrowHead(at tip: CGPoint, angle: Double, size: CGFloat = 13) {
    let forward = direction(angle)
    let side = CGPoint(x: -forward.y, y: forward.x)
    let base = CGPoint(x: tip.x - forward.x * size, y: tip.y - forward.y * size)
    let head = UIBezierPath()
    head.move(to: tip)
    head.addLine(to: CGPoint(x: base.x + side.x * size * 0.62, y: base.y + side.y * size * 0.62))
    head.addLine(to: CGPoint(x: base.x - side.x * size * 0.62, y: base.y - side.y * size * 0.62))
    head.close()
    head.fill()
  }

  private static func drawTurn(angle: Double, in context: CGContext) {
    // A sharp turn doubles back, so its junction sits higher and its stem moves away from the
    // returning arm; otherwise the arrowhead lands on the stem.
    let sharp = abs(angle) > 110
    let stemX: CGFloat = sharp ? (angle > 0 ? 13 : 37) : 25
    let junction = CGPoint(x: stemX, y: sharp ? 12 : 26)
    let stemStart = CGPoint(x: stemX, y: 48)
    let armLength: CGFloat = sharp ? 32 : 19
    let forward = direction(angle)
    let shaftEnd = CGPoint(
      x: junction.x + forward.x * (armLength - 9),
      y: junction.y + forward.y * (armLength - 9)
    )
    let tip = CGPoint(x: junction.x + forward.x * armLength, y: junction.y + forward.y * armLength)
    let path = UIBezierPath()
    path.move(to: stemStart)
    path.addLine(to: junction)
    path.addLine(to: shaftEnd)
    path.lineWidth = 6
    path.lineJoinStyle = .round
    path.lineCapStyle = .butt
    path.stroke()
    drawArrowHead(at: tip, angle: angle)
  }

  /// Canada drives on the right, so U-turns sweep to the left.
  private static func drawUTurn(in context: CGContext) {
    let path = UIBezierPath()
    path.move(to: CGPoint(x: 32, y: 48))
    path.addLine(to: CGPoint(x: 32, y: 20))
    path.addArc(
      withCenter: CGPoint(x: 23, y: 20), radius: 9, startAngle: 0, endAngle: .pi, clockwise: false)
    path.addLine(to: CGPoint(x: 14, y: 30))
    path.lineWidth = 6
    path.lineJoinStyle = .round
    path.stroke()
    drawArrowHead(at: CGPoint(x: 14, y: 42), angle: 180)
  }

  /// Counter-clockwise circulation (right-hand traffic) from the entry at the bottom to the exit,
  /// with the other part of the ring drawn faintly.
  private static func drawRoundabout(exitAngle: Double, exit: Int?, in context: CGContext) {
    let center = CGPoint(x: 25, y: 22)
    let radius: CGFloat = 9
    let ring = UIBezierPath(arcCenter: center, radius: radius, startAngle: 0, endAngle: 2 * .pi, clockwise: true)
    ring.lineWidth = 3
    UIColor.black.withAlphaComponent(0.35).setStroke()
    ring.stroke()
    UIColor.black.setStroke()

    // Exit angle 0 is straight on (top); circulation runs from the bottom (180°) down through
    // right (90°) to the exit. A U-turn exit (−180°) goes all the way round.
    var exitDegrees = exitAngle
    if exitDegrees >= 180 { exitDegrees = -180 }
    let startRadians = CGFloat((180 - 90) * Double.pi / 180)
    let endRadians = CGFloat((exitDegrees - 90) * Double.pi / 180)
    let path = UIBezierPath()
    path.move(to: CGPoint(x: 25, y: 48))
    path.addLine(to: CGPoint(x: 25, y: center.y + radius))
    path.addArc(
      withCenter: center, radius: radius, startAngle: startRadians, endAngle: endRadians,
      clockwise: false)
    let forward = direction(exitDegrees)
    let shaftEnd = CGPoint(
      x: center.x + forward.x * (radius + 5), y: center.y + forward.y * (radius + 5))
    path.addLine(to: shaftEnd)
    path.lineWidth = 5
    path.lineJoinStyle = .round
    path.stroke()
    drawArrowHead(
      at: CGPoint(x: center.x + forward.x * (radius + 15), y: center.y + forward.y * (radius + 15)),
      angle: exitDegrees,
      size: 11
    )
  }

  @available(iOS 17.4, *)
  static func maneuverType(_ kind: NavOSSCarPlayManeuverKind) -> CPManeuverType {
    switch kind {
    case .depart: .startRoute
    case .straight: .straightAhead
    case .followRoad: .followRoad
    case .slightLeft: .slightLeftTurn
    case .left: .leftTurn
    case .sharpLeft: .sharpLeftTurn
    case .slightRight: .slightRightTurn
    case .right: .rightTurn
    case .sharpRight: .sharpRightTurn
    case .uTurn: .uTurn
    case .keepLeft, .mergeLeft: .keepLeft
    case .keepRight, .mergeRight: .keepRight
    case .onRamp: .onRamp
    case .offRampLeft: .highwayOffRampLeft
    case .offRampRight: .highwayOffRampRight
    case .leftAtEnd: .leftTurnAtEnd
    case .rightAtEnd: .rightTurnAtEnd
    case let .roundabout(exit):
      if let exit, (1...19).contains(exit),
        let type = CPManeuverType(rawValue: CPManeuverType.roundaboutExit1.rawValue + UInt(exit - 1))
      {
        type
      } else {
        .enterRoundabout
      }
    case .exitRoundabout: .exitRoundabout
    case .ferry: .enter_Ferry
    case .arrive: .arriveAtDestination
    case .arriveLeft: .arriveAtDestinationLeft
    case .arriveRight: .arriveAtDestinationRight
    }
  }
}
