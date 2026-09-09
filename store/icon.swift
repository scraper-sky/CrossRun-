import AppKit
let size = 1024.0
let root = "/Users/jerryxiao/software-projects/software/crossword_game/assets/wood/"
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
// walnut ground: the plank texture, darkened a touch
NSColor(red: 0.36, green: 0.23, blue: 0.13, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: size, height: size).fill()
if let plank = NSImage(contentsOfFile: root + "plank_dark.png") {
  let h = size * 0.16
  var y = -h * 0.3
  while y < size { plank.draw(in: NSRect(x: -20, y: y, width: size + 40, height: h), from: .zero, operation: .sourceOver, fraction: 0.9); y += h * 0.98 }
}
NSColor(red: 0, green: 0, blue: 0, alpha: 0.18).setFill(); NSRect(x: 0, y: 0, width: size, height: size).fill()
func tile(_ letter: String, cx: Double, cy: Double, w: Double, angle: Double) {
  ctx.saveGState()
  ctx.translateBy(x: cx, y: cy); ctx.rotate(by: angle * .pi / 180)
  // soft shadow
  ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 40, color: NSColor(white: 0, alpha: 0.45).cgColor)
  if let t = NSImage(contentsOfFile: root + "tile_light.png") { t.draw(in: NSRect(x: -w/2, y: -w/2, width: w, height: w * 1.04)) }
  ctx.setShadow(offset: .zero, blur: 0, color: nil)
  let font = NSFont(name: "IowanOldStyle-Bold", size: w * 0.62) ?? NSFont.boldSystemFont(ofSize: w * 0.62)
  let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(red: 0.23, green: 0.16, blue: 0.10, alpha: 1)]
  let s = NSAttributedString(string: letter, attributes: attrs)
  let sz = s.size()
  s.draw(at: NSPoint(x: -sz.width/2, y: -sz.height/2 + w * 0.02))
  ctx.restoreGState()
}
tile("R", cx: size * 0.66, cy: size * 0.63, w: size * 0.50, angle: 14)
tile("C", cx: size * 0.38, cy: size * 0.41, w: size * 0.58, angle: -8)
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("icon written")
