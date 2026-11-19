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
