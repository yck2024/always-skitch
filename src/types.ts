export type Tool = 'select' | 'arrow' | 'rectangle' | 'text' | 'callout' | 'blur';

export type ToastTone = 'success' | 'warning' | 'info';

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
}
