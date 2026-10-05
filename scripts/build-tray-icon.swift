import Cocoa

// Use only the canonical foreground's alpha: app-icon backgrounds must never
// become part of a macOS template image.
let resources = CommandLine.arguments[1]
guard let source = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: resources + "/Bridge.icon/Assets/mark.png"))) else {
    fatalError("Cannot read Bridge mark")
}
var minX = source.pixelsWide, minY = source.pixelsHigh, maxX = 0, maxY = 0
for y in 0..<source.pixelsHigh {
    for x in 0..<source.pixelsWide {
        if (source.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
            minX = min(minX, x); minY = min(minY, y)
            maxX = max(maxX, x); maxY = max(maxY, y)
        }
    }
}
guard maxX > minX, maxY > minY, let original = source.cgImage,
      let cropped = original.cropping(to: CGRect(x: minX, y: minY, width: maxX-minX+1, height: maxY-minY+1)) else {
    fatalError("Bridge mark is empty")
}
for scale in [1, 2] {
    let size = 18 * scale
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let width = CGFloat(16 * scale)
    let height = width * CGFloat(cropped.height) / CGFloat(cropped.width)
    context.interpolationQuality = .high
    context.draw(cropped, in: CGRect(x: CGFloat(scale), y: (CGFloat(size)-height)/2, width: width, height: height))
    context.setBlendMode(.sourceIn)
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let output = NSBitmapImageRep(cgImage: context.makeImage()!)
    output.size = NSSize(width: 18, height: 18)
    let suffix = scale == 1 ? "" : "@2x"
    try output.representation(using: .png, properties: [:])!.write(
        to: URL(fileURLWithPath: resources + "/bridge-tray-iconTemplate" + suffix + ".png"))
}
