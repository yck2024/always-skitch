export const EXPORT_FILE_NAME = 'mini-skitch-annotated.png';

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export function downloadDataUrl(dataUrl: string, fileName = EXPORT_FILE_NAME): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export async function copyPngBlobToClipboard(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard || !('ClipboardItem' in window)) {
    return false;
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type || 'image/png']: blob,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
