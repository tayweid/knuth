// The launcher's window while an app completes itself (launcher.sh): a
// plain AppKit window with a progress bar, drawn from a script so nothing
// is compiled. Electron is not there yet, so the page cannot be the UI.
//
//   osascript -l JavaScript progress.js <title> <status-file> <icon>
//
// Follows the status file's last "percent|text" line until the file named
// <status-file>.done appears, then closes.
//
// Its being an AppKit process costs one thing: a launch that shows it loses
// the "open" event of a document that launch was for (macOS counts the app
// as checked in and sends the event to the launcher, a shell script). Only
// the completing launch shows it, so only a document opened with an app's
// very first launch opens as a blank window instead. Measured 2026-09-29:
// an AppKit child of the launch loses the event with or without a window,
// at any delay; a separately opened helper app keeps it, at the cost of a
// second Gatekeeper prompt for a browser download.
ObjC.import('Cocoa');

function run(argv) {
  const [title, statusPath, iconPath] = argv;
  const app = $.NSApplication.sharedApplication;
  // No Dock icon of its own: the app's own icon is already bouncing.
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, 440, 132),
    $.NSWindowStyleMaskTitled,
    $.NSBackingStoreBuffered,
    false,
  );
  win.title = title;
  const view = win.contentView;
  if (iconPath) {
    const image = $.NSImage.alloc.initWithContentsOfFile(iconPath);
    const icon = $.NSImageView.imageViewWithImage(image);
    icon.frame = $.NSMakeRect(20, 36, 64, 64);
    view.addSubview(icon);
  }
  const heading = $.NSTextField.labelWithString(`Getting ${title} ready`);
  heading.font = $.NSFont.boldSystemFontOfSize(13);
  heading.frame = $.NSMakeRect(100, 84, 320, 20);
  view.addSubview(heading);
  const label = $.NSTextField.labelWithString('One moment…');
  label.frame = $.NSMakeRect(100, 60, 320, 20);
  label.textColor = $.NSColor.secondaryLabelColor;
  view.addSubview(label);
  const bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(100, 32, 320, 20));
  bar.minValue = 0;
  bar.maxValue = 100;
  bar.indeterminate = true;
  bar.startAnimation(null);
  view.addSubview(bar);
  win.center;
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);

  const files = $.NSFileManager.defaultManager;
  const done = `${statusPath}.done`;
  let shown = '';
  while (!files.fileExistsAtPath(done)) {
    const text = $.NSString.stringWithContentsOfFileEncodingError(statusPath, $.NSUTF8StringEncoding, null);
    const lines = text.isNil() ? [] : text.js.trim().split('\n');
    const last = lines[lines.length - 1] ?? '';
    if (last && last !== shown) {
      shown = last;
      const cut = last.indexOf('|');
      const percent = last.slice(0, cut);
      label.stringValue = last.slice(cut + 1);
      if (percent === '') {
        bar.indeterminate = true;
        bar.startAnimation(null);
      } else {
        bar.indeterminate = false;
        bar.doubleValue = Number(percent);
      }
    }
    const event = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny,
      $.NSDate.dateWithTimeIntervalSinceNow(0.15),
      $.NSDefaultRunLoopMode,
      true,
    );
    if (!event.isNil()) app.sendEvent(event);
  }
  win.close;
  return '';
}
