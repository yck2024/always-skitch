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

export async function copyPngDataUrlToClipboard(dataUrl: string): Promise<boolean> {
  if (!navigator.clipboard || !('ClipboardItem' in window)) {
    return false;
  }

  try {
    const blobPromise = dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blobPromise,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
