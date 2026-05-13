export async function readImageFromClipboard(): Promise<File | null> {
  if (!navigator.clipboard || !('read' in navigator.clipboard)) {
    return null;
  }

  // Clipboard image reads only work in secure contexts: localhost or HTTPS.
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'));
    if (imageType) {
      const blob = await item.getType(imageType);
      return new File([blob], 'clipboard-image.png', { type: blob.type || 'image/png' });
    }
  }

  return null;
}

export function getImageFileFromPaste(event: ClipboardEvent): File | null {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.type.startsWith('image/'));
  return imageItem?.getAsFile() ?? null;
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
