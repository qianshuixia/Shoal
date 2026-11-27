import { execFile } from 'node:child_process';

// Files copied in Explorer (a file drop list on the system clipboard). The browser's paste event carries them without
// their paths, so the page asks the server, which runs on the same machine and shares the clipboard.
const SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';

// macOS: file URLs on the general pasteboard, read through JXA. Not verified on a real Mac yet.
const SCRIPT_MAC = [
  "ObjC.import('AppKit');",
  'var urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({}));',
  'var out = [];',
  'if (urls) for (var i = 0; i < urls.count; i++) { var u = urls.objectAtIndex(i); if (u.isFileURL && u.path) out.push(u.path.js); }',
  "out.join('\\n');",
].join('\n');

export function clipboardFiles(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', SCRIPT_MAC], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(new Error(`读取剪贴板失败：${err.message}`));
        else resolve(stdout.split(/\r?\n/).filter(Boolean));
      });
    });
  }
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(new Error(`读取剪贴板失败：${err.message}`));
      else resolve(stdout.split(/\r?\n/).filter(Boolean));
    });
  });
}

const WRITE_SCRIPT_WIN = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$col = New-Object System.Collections.Specialized.StringCollection;',
  '$raw = [Environment]::GetEnvironmentVariable("SHOAL_CLIP_PATHS");',
  'foreach ($p in ($raw -split "`n")) { if ($p) { [void]$col.Add($p) } }',
  'if ($col.Count -gt 0) { [System.Windows.Forms.Clipboard]::SetFileDropList($col) }',
].join(' ');

const WRITE_SCRIPT_MAC = [
  "ObjC.import('AppKit');",
  "ObjC.import('Foundation');",
  'var raw = $.NSProcessInfo.processInfo.environment.objectForKey("SHOAL_CLIP_PATHS").js || "";',
  'var lines = raw.split("\\n").filter(Boolean);',
  'var pb = $.NSPasteboard.generalPasteboard;',
  'pb.clearContents;',
  'var arr = $.NSMutableArray.alloc.init;',
  'for (var i = 0; i < lines.length; i++) arr.addObject($.NSURL.fileURLWithPath(lines[i]));',
  'if (lines.length > 0) pb.writeObjects(arr);',
].join('\n');

export function writeClipboardFiles(paths: string[]): Promise<void> {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  if (clean.length === 0) return Promise.resolve();
  // Never touch the host clipboard during automated tests.
  if (process.env.WORKBENCH_OPEN_LOG || process.env.WORKBENCH_FAKE_AGENT === '1') return Promise.resolve();
  const env = { ...process.env, SHOAL_CLIP_PATHS: clean.join('\n') };
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', WRITE_SCRIPT_MAC], { env, timeout: 5000 }, (err) => {
        if (err) reject(new Error(`写入剪贴板失败：${err.message}`));
        else resolve();
      });
    });
  }
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WRITE_SCRIPT_WIN], { env, windowsHide: true, timeout: 5000 }, (err) => {
      if (err) reject(new Error(`写入剪贴板失败：${err.message}`));
      else resolve();
    });
  });
}

const IMAGE_SCRIPT_WIN = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type -AssemblyName System.Drawing;',
  'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
  '  $img = [System.Windows.Forms.Clipboard]::GetImage();',
  '  if ($img) {',
  '    $ms = New-Object System.IO.MemoryStream;',
  '    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);',
  '    [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()));',
  '    $ms.Dispose();',
  '    $img.Dispose();',
  '  }',
  '}',
].join(' ');

const IMAGE_SCRIPT_MAC = [
  "ObjC.import('AppKit');",
  'var pb = $.NSPasteboard.generalPasteboard;',
  'var data = pb.dataForType($.NSPasteboardTypePNG);',
  'if (!data) {',
  '  var tiff = pb.dataForType($.NSPasteboardTypeTIFF);',
  '  if (tiff) {',
  '    var rep = $.NSBitmapImageRep.imageRepWithData(tiff);',
  '    if (rep) data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));',
  '  }',
  '}',
  'data ? data.base64EncodedStringWithOptions(0).js : "";',
].join('\n');

// Reads a bitmap image directly from the local OS clipboard as PNG bytes (returns null if no image is present).
// Used by desktop StreamView as a fallback when Chrome omits image data from ClipboardEvent.clipboardData.files.
export function clipboardImagePng(): Promise<Buffer | null> {
  if (process.env.WORKBENCH_OPEN_LOG || process.env.WORKBENCH_FAKE_AGENT === '1') return Promise.resolve(null);
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', '-e', IMAGE_SCRIPT_MAC], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(new Error(`读取剪贴板图片失败：${err.message}`));
        else {
          const b64 = stdout.trim();
          resolve(b64 ? Buffer.from(b64, 'base64') : null);
        }
      });
    });
  }
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', IMAGE_SCRIPT_WIN], { windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`读取剪贴板图片失败：${err.message}`));
      else {
        const b64 = stdout.trim();
        resolve(b64 ? Buffer.from(b64, 'base64') : null);
      }
    });
  });
}
