import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  extractTaskClipboardFileReferences,
  inferTaskClipboardAttachmentMimeType,
  readTaskAttachmentFilePathPayloads,
  readTaskClipboardAttachmentsFromClipboard,
} from '../src/main/taskClipboard.js';

describe('native task clipboard parsing', () => {
  it('extracts local file references from macOS clipboard uri-list, html and plain text payloads', () => {
    const references = extractTaskClipboardFileReferences([
      'file:///Users/david/Desktop/Zeus%20shot.png\n# ignored\nfile:///Users/david/Desktop/spec.pdf',
      '<meta charset="utf-8"><img src="file:///Users/david/Pictures/Paste%20Image.png"><a href="file:///Users/david/Downloads/log.txt">log</a>',
      '/Users/david/hypha/zeus/README.md\nnot a path\nfile:///Users/david/Desktop/Zeus%20shot.png',
    ]);

    expect(references).toEqual(['/Users/david/Desktop/Zeus shot.png', '/Users/david/Desktop/spec.pdf', '/Users/david/Pictures/Paste Image.png', '/Users/david/Downloads/log.txt', '/Users/david/hypha/zeus/README.md']);
  });

  it('infers image mime types from pasted local file names and accepts typed-array IPC payloads', () => {
    expect(inferTaskClipboardAttachmentMimeType('/tmp/shot.PNG')).toBe('image/png');
    expect(inferTaskClipboardAttachmentMimeType('/tmp/photo.heic')).toBe('image/heic');
    expect(inferTaskClipboardAttachmentMimeType('/tmp/report.pdf')).toBe('application/pdf');
    expect(inferTaskClipboardAttachmentMimeType('/tmp/table.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(inferTaskClipboardAttachmentMimeType('/tmp/slides.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(inferTaskClipboardAttachmentMimeType('/tmp/archive.unknown')).toBe('application/octet-stream');

    const view = new Uint8Array([137, 80, 78, 71]);
    expect([...coerceTaskClipboardAttachmentBuffer(view)!]).toEqual([137, 80, 78, 71]);
  });

  it('reads inline HTML data images and native image buffers when Electron readImage is empty', async () => {
    const inlineAttachments = await readTaskClipboardAttachmentsFromClipboard({
      readImage: () => ({ isEmpty: () => true, toPNG: () => new Uint8Array() }),
      availableFormats: () => [],
      readBuffer: () => new Uint8Array(),
      readText: () => '',
      readHTML: () => '<img src="data:image/png;base64,iVBORw0KGgo=">',
    });

    expect(inlineAttachments).toHaveLength(1);
    expect(inlineAttachments[0]?.type).toBe('image/png');
    expect([...new Uint8Array(inlineAttachments[0]!.data)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const nativeBufferAttachments = await readTaskClipboardAttachmentsFromClipboard({
      readImage: () => ({ isEmpty: () => true, toPNG: () => new Uint8Array() }),
      availableFormats: () => ['public.png'],
      readBuffer: (format) => (format === 'public.png' ? new Uint8Array([137, 80, 78, 71]) : new Uint8Array()),
      readText: () => '',
      readHTML: () => '',
    });

    expect(nativeBufferAttachments).toHaveLength(1);
    expect(nativeBufferAttachments[0]?.type).toBe('image/png');
    expect([...new Uint8Array(nativeBufferAttachments[0]!.data)]).toEqual([137, 80, 78, 71]);
  });

  it('reads pasted local files from private macOS clipboard formats with embedded paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-task-clipboard-'));
    const filePath = join(directory, 'Zeus 2026-06-29 16.35.57.png');
    await writeFile(filePath, new Uint8Array([137, 80, 78, 71]));

    const privatePasteboardPayload = new TextEncoder().encode(`bplist00\\u0000metadata file://${filePath.replaceAll(' ', '%20')} trailing-private-data`);
    const attachments = await readTaskClipboardAttachmentsFromClipboard({
      readImage: () => ({ isEmpty: () => true, toPNG: () => new Uint8Array() }),
      availableFormats: () => ['com.wiheads.paste.private-file-reference'],
      readBuffer: () => privatePasteboardPayload,
      readText: () => '',
      readHTML: () => '',
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('Zeus 2026-06-29 16.35.57.png');
    expect(attachments[0]?.type).toBe('image/png');
    expect([...new Uint8Array(attachments[0]!.data)]).toEqual([137, 80, 78, 71]);
  });

  it('prefers the real local file over Finder or Paste preview bitmaps when both are present', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-task-clipboard-local-file-'));
    const filePath = join(directory, 'Local file preview.png');
    await writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const fileReferencePayload = new TextEncoder().encode(`file://${filePath.replaceAll(' ', '%20')}`);
    const attachments = await readTaskClipboardAttachmentsFromClipboard({
      readImage: () => ({
        isEmpty: () => false,
        toPNG: () => new Uint8Array([0, 0, 0, 0]),
      }),
      availableFormats: () => ['public.file-url'],
      readBuffer: () => fileReferencePayload,
      readText: () => '',
      readHTML: () => '',
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('Local file preview.png');
    expect(attachments[0]?.type).toBe('image/png');
    expect([...new Uint8Array(attachments[0]!.data)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('prefers macOS Finder furl file references when Electron exposes only filenames and a file icon bitmap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-task-clipboard-finder-furl-'));
    const filePath = join(directory, 'Real Finder Photo.jpg');
    await writeFile(filePath, new Uint8Array([255, 216, 255, 224]));

    const attachments = await readTaskClipboardAttachmentsFromClipboard(
      {
        readImage: () => ({
          isEmpty: () => false,
          toPNG: () => new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]),
        }),
        availableFormats: () => ['text/plain', 'text/uri-list'],
        readBuffer: () => new Uint8Array(),
        readText: () => 'Real Finder Photo.jpg',
        readHTML: () => 'Real Finder Photo.jpg',
      },
      {
        readSystemFileReferences: async () => [filePath],
      },
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('Real Finder Photo.jpg');
    expect(attachments[0]?.type).toBe('image/jpeg');
    expect([...new Uint8Array(attachments[0]!.data)]).toEqual([255, 216, 255, 224]);
  });

  it('turns selected local image file paths into the same previewable payloads used by clipboard attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeus-task-picker-local-file-'));
    const filePath = join(directory, 'iShot_2026-06-21_10.53.20.png');
    await writeFile(filePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const attachments = await readTaskAttachmentFilePathPayloads([filePath], async (path) => {
      expect(path).toBe(filePath);
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('iShot_2026-06-21_10.53.20.png');
    expect(attachments[0]?.type).toBe('image/png');
    expect([...new Uint8Array(attachments[0]!.data)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('builds Codex-style data URL previews from image payload bytes instead of renderer file URLs', () => {
    const previewUrl = buildTaskAttachmentPreviewDataUrl(new Uint8Array([137, 80, 78, 71]), 'image/png');

    expect(previewUrl).toBe('data:image/png;base64,iVBORw==');
    expect(buildTaskAttachmentPreviewDataUrl(new Uint8Array([1, 2, 3]), 'application/pdf')).toBeUndefined();
  });
});
