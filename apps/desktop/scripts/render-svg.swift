import AppKit
import Foundation

let input = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
let width = Int(CommandLine.arguments[3])!
let height = Int(CommandLine.arguments[4])!

guard let image = NSImage(contentsOfFile: input) else { fatalError("SVG 读取失败：\(input)") }
let canvas = NSImage(size: NSSize(width: width, height: height))
canvas.lockFocus()
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
image.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
canvas.unlockFocus()

guard let tiff = canvas.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fatalError("SVG PNG 编码失败：\(input)")
}
try png.write(to: URL(fileURLWithPath: output))
