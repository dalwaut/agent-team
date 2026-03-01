import React from 'react';
import type { Attachment } from '../../types';
export type { Attachment };
interface InputAreaProps {
    onSend: (text: string, attachments: Attachment[]) => void;
    disabled?: boolean;
}
export default function InputArea({ onSend, disabled }: InputAreaProps): React.ReactElement;
