import Cocoa
import CoreGraphics

let args = CommandLine.arguments
guard args.count == 7 || args.count == 16 else {
    fatalError("usage: squircle <input.png> <output.png> <canvas> <squircle> <radius> <inset> <light-r> <light-g> <light-b> <mid-r> <mid-g> <mid-b> <shadow-r> <shadow-g> <shadow-b>")
}
let inputPath = args[1]
let outputPath = args[2]
let canvas = Int(args[3])!
let squircle = CGFloat(Double(args[4])!)
let radius = CGFloat(Double(args[5])!)
let inset = CGFloat(Double(args[6])!)

guard let src = NSImage(contentsOfFile: inputPath) else { fatalError("cannot load \(inputPath)") }
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bytesPerRow = canvas * 4
guard let ctx = CGContext(
    data: nil,
    width: canvas,
    height: canvas,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("cannot create context") }

let canvasRect = CGRect(x: 0, y: 0, width: canvas, height: canvas)
ctx.clear(canvasRect)

let squircleRect = CGRect(x: inset, y: inset, width: squircle, height: squircle)
let clipPath = CGPath(roundedRect: squircleRect, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.addPath(clipPath)
ctx.clip()

if args.count == 16 {
    let light = NSColor(srgbRed: CGFloat(Double(args[7])!), green: CGFloat(Double(args[8])!), blue: CGFloat(Double(args[9])!), alpha: 1).cgColor
    let midpoint = NSColor(srgbRed: CGFloat(Double(args[10])!), green: CGFloat(Double(args[11])!), blue: CGFloat(Double(args[12])!), alpha: 1).cgColor
    let shadow = NSColor(srgbRed: CGFloat(Double(args[13])!), green: CGFloat(Double(args[14])!), blue: CGFloat(Double(args[15])!), alpha: 1).cgColor
    guard let gradient = CGGradient(
        colorsSpace: colorSpace,
        colors: [light, midpoint, shadow] as CFArray,
        locations: [0, 0.52, 1]
    ) else { fatalError("cannot create background gradient") }
    ctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: squircleRect.minX, y: squircleRect.maxY),
        end: CGPoint(x: squircleRect.maxX, y: squircleRect.minY),
        options: []
    )
} else {
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fill(squircleRect)
}

var imageRect = squircleRect
guard let cgSrc = src.cgImage(forProposedRect: &imageRect, context: nil, hints: nil) else { fatalError("cannot get cgImage") }
ctx.draw(cgSrc, in: squircleRect)
ctx.restoreGState()

guard let cgOut = ctx.makeImage() else { fatalError("cannot finalise image") }
let rep = NSBitmapImageRep(cgImage: cgOut)
rep.size = NSSize(width: canvas, height: canvas)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("cannot encode png") }
try png.write(to: URL(fileURLWithPath: outputPath))
